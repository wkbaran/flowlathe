import fastifyStatic from "@fastify/static";
import type { PluginManifest, ToolRegistration } from "@flowlathe/core";
import type { Db } from "@flowlathe/persistence";
import { SPOTIFY_MANIFEST, type SpotifyOAuthConfig } from "@flowlathe/plugin-spotify";
import Fastify, { type FastifyInstance } from "fastify";
import { DEFAULT_ALLOWED_HOSTS, isHostAllowed } from "./allowed-hosts.js";
import { ExecutionHub } from "./execution-hub.js";
import { flowsDir as defaultFlowsDir } from "./flow-store.js";
import { FlowsHub } from "./flows-hub.js";
import { registerExecutionRoutes } from "./routes/executions.js";
import { registerFlowRoutes } from "./routes/flows.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSpotifyPluginRoutes } from "./routes/plugins-spotify.js";
import { registerPluginRoutes, type McpServerStatus } from "./routes/plugins.js";
import { registerTriggerRoutes } from "./routes/triggers.js";
import type { SchedulerRegistry } from "./scheduler-registry.js";
import type { TriggerRegistry } from "./triggers/registry.js";

export interface BuildAppOptions {
  db: Db;
  credentialKey: Buffer;
  schedulerRegistry: SchedulerRegistry;
  staticRoot?: string;
  /** Undefined (no Spotify config) when SPOTIFY_CLIENT_ID isn't set. */
  spotifyConfig?: SpotifyOAuthConfig | undefined;
  /** Tool registrations contributed by configured plugins (e.g. Spotify, MCP servers), threaded
   *  into every execution's ToolRegistry alongside the built-in "state" toolset. Empty when none
   *  configured. */
  pluginToolsets?: ToolRegistration[] | undefined;
  /** Manifests for every plugin *package* compiled into this server, regardless of whether it's
   *  actually configured — see `routes/plugins.ts`. Always includes Spotify's; a caller adds its
   *  own as new plugins are wired in (`index.ts`). */
  pluginManifests?: PluginManifest[] | undefined;
  /** One entry per successfully-or-unsuccessfully-discovered MCP server, for `/api/plugins/status`. */
  mcpStatuses?: Record<string, McpServerStatus> | undefined;
  /** Shared with the caller (`index.ts`) rather than built internally, so a `TriggerRegistry`
   *  constructed before `buildApp` runs observes the same execution-completion events flow
   *  routes publish. Defaults to a fresh `ExecutionHub` (existing tests that never need to share
   *  one are unaffected). */
  hub?: ExecutionHub;
  /** Absent in every existing test and in a server with no trigger configured at all — `/api/
   *  triggers` is only registered when a registry is provided, since starting/stopping a trigger
   *  needs one. */
  triggerRegistry?: TriggerRegistry;
  /** PLAN-FLOW-DSL.md S3: the directory `PUT /api/flows/:id` writes `.flow` files into and
   *  `/api/executions/:id/step` reads the current graph from. Defaults to `flowsDir()`
   *  (`FLOWLATHE_FLOWS_DIR`, or `./flows`) — tests pass a throwaway temp dir instead. */
  flowsDir?: string;
  /** Shared with the caller the same way `hub` is, so `index.ts`'s file watcher and this app's
   *  `/api/flows/events` SSE route publish/subscribe to the same topic. Defaults to a fresh one. */
  flowsHub?: FlowsHub;
  /** PLAN-NETWORK-POSTURE.md: the `Host` header allowlist. Defaults to loopback only
   *  (`DEFAULT_ALLOWED_HOSTS`) — the API is unauthenticated, so this is the one thing standing
   *  between a public web page and a request landing on this server via DNS rebinding. */
  allowedHosts?: string[];
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const allowedHosts = opts.allowedHosts ?? DEFAULT_ALLOWED_HOSTS;
  app.addHook("onRequest", async (request, reply) => {
    if (isHostAllowed(request.headers.host, allowedHosts)) return;
    await reply.code(403).send({ error: "forbidden host" });
  });
  const hub = opts.hub ?? new ExecutionHub();
  const flowsDir = opts.flowsDir ?? defaultFlowsDir();
  const flowsHub = opts.flowsHub ?? new FlowsHub();

  registerFlowRoutes(app, {
    db: opts.db,
    hub,
    scheduler: opts.schedulerRegistry,
    pluginToolsets: opts.pluginToolsets,
    flowsDir,
    flowsHub,
  });
  registerExecutionRoutes(app, {
    db: opts.db,
    hub,
    scheduler: opts.schedulerRegistry,
    pluginToolsets: opts.pluginToolsets,
    flowsDir,
  });
  registerProviderRoutes(app, {
    db: opts.db,
    credentialKey: opts.credentialKey,
    schedulerRegistry: opts.schedulerRegistry,
  });
  registerSpotifyPluginRoutes(app, {
    db: opts.db,
    credentialKey: opts.credentialKey,
    config: opts.spotifyConfig,
  });
  registerPluginRoutes(app, {
    manifests: opts.pluginManifests ?? [SPOTIFY_MANIFEST],
    pluginToolsets: opts.pluginToolsets ?? [],
    ...(opts.mcpStatuses ? { mcpStatuses: opts.mcpStatuses } : {}),
  });
  if (opts.triggerRegistry) {
    registerTriggerRoutes(app, { db: opts.db, registry: opts.triggerRegistry, pluginToolsets: opts.pluginToolsets });
  }

  if (opts.staticRoot) {
    const staticRoot = opts.staticRoot;
    app.register(fastifyStatic, { root: staticRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html", staticRoot);
    });
  }

  return app;
}
