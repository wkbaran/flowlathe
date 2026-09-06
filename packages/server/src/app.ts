import fastifyStatic from "@fastify/static";
import type { ToolRegistration } from "@flowlathe/core";
import type { Db } from "@flowlathe/persistence";
import type { SpotifyOAuthConfig } from "@flowlathe/plugin-spotify";
import Fastify, { type FastifyInstance } from "fastify";
import { ExecutionHub } from "./execution-hub.js";
import { registerExecutionRoutes } from "./routes/executions.js";
import { registerFlowRoutes } from "./routes/flows.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSpotifyPluginRoutes, type McpServerStatus } from "./routes/plugins-spotify.js";
import type { SchedulerRegistry } from "./scheduler-registry.js";

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
  /** One entry per successfully-or-unsuccessfully-discovered MCP server, for `/api/plugins/status`. */
  mcpStatuses?: Record<string, McpServerStatus> | undefined;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const hub = new ExecutionHub();

  registerFlowRoutes(app, {
    db: opts.db,
    hub,
    scheduler: opts.schedulerRegistry,
    pluginToolsets: opts.pluginToolsets,
  });
  registerExecutionRoutes(app, {
    db: opts.db,
    hub,
    scheduler: opts.schedulerRegistry,
    pluginToolsets: opts.pluginToolsets,
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
    ...(opts.mcpStatuses ? { mcpStatuses: opts.mcpStatuses } : {}),
  });

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
