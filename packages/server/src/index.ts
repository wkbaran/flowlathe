import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import type { PluginManifest, ToolRegistration } from "@flowlathe/core";
import { ensureDefaultMockProvider, getPluginCredential, openDb, runMigrations, setPluginCredential } from "@flowlathe/persistence";
import { createSpotifyToolset, SpotifyClient, SPOTIFY_MANIFEST, type SpotifyOAuthConfig } from "@flowlathe/plugin-spotify";
import { searxngToolsetFromEnv, SEARXNG_MANIFEST } from "@flowlathe/plugin-searxng";
import { firecrawlToolsetFromEnv, FIRECRAWL_MANIFEST } from "@flowlathe/plugin-firecrawl";
import { discordClientFromEnv, discordToolsetFromEnv, DISCORD_MANIFEST } from "@flowlathe/plugin-discord";
import { listTriggers } from "@flowlathe/persistence";
import { buildApp } from "./app.js";
import { resolveCredentialKey } from "./credential-key.js";
import { ExecutionHub } from "./execution-hub.js";
import { discoverMcpToolsets, loadMcpServersConfig } from "./mcp-config.js";
import { SchedulerRegistry } from "./scheduler-registry.js";
import { TriggerRegistry } from "./triggers/registry.js";

const here = dirname(fileURLToPath(import.meta.url));

const port = Number(process.env["PORT"] ?? 4310);
const dbPath = process.env["FLOWLATHE_DB_PATH"] ?? join(here, "..", "data", "flowlathe.sqlite");
const dataDir = process.env["FLOWLATHE_DATA_DIR"] ?? dirname(dbPath);
const staticRoot = process.env["FLOWLATHE_STATIC_ROOT"] ?? join(here, "..", "..", "web", "dist");

mkdirSync(dirname(dbPath), { recursive: true });

const opened = openDb(dbPath);
runMigrations(opened);
ensureDefaultMockProvider(opened.db);

const credentialKey = resolveCredentialKey(dataDir);
const schedulerRegistry = new SchedulerRegistry(opened.db, credentialKey);

const pluginManifests: PluginManifest[] = [SPOTIFY_MANIFEST, SEARXNG_MANIFEST, FIRECRAWL_MANIFEST, DISCORD_MANIFEST];

const spotifyClientId = process.env["SPOTIFY_CLIENT_ID"];
let spotifyConfig: SpotifyOAuthConfig | undefined;
let pluginToolsets: ToolRegistration[] = [];
if (spotifyClientId) {
  spotifyConfig = {
    clientId: spotifyClientId,
    redirectUri: process.env["SPOTIFY_REDIRECT_URI"] ?? `http://127.0.0.1:${port}/api/plugins/spotify/oauth/callback`,
  };
  const spotifyClient = new SpotifyClient({
    config: spotifyConfig,
    tokens: {
      getRefreshToken: () => getPluginCredential(opened.db, credentialKey, "spotify"),
      saveRefreshToken: (token) => setPluginCredential(opened.db, credentialKey, "spotify", token),
    },
  });
  pluginToolsets = createSpotifyToolset(spotifyClient);
}
pluginToolsets = [...pluginToolsets, ...searxngToolsetFromEnv(), ...firecrawlToolsetFromEnv(), ...discordToolsetFromEnv()];

/** `MCP_SERVERS_CONFIG_PATH` points at a JSON file in the same `{"mcpServers": {...}}` shape
 *  Claude Desktop/Code use. Discovery is async (each server is connected to once, to list its
 *  tools), so the rest of boot waits on it — see `mcp-config.ts`. `MCP_ALLOWED_COMMANDS` gates
 *  which commands a stdio server config may spawn; unset means none may (secure default). */
const mcpServersConfigPath = process.env["MCP_SERVERS_CONFIG_PATH"];
const mcpServers = mcpServersConfigPath ? loadMcpServersConfig(mcpServersConfigPath) : {};
const { toolsets: mcpToolsets, statuses: mcpStatuses } = await discoverMcpToolsets(
  mcpServers,
  process.env["MCP_ALLOWED_COMMANDS"],
);
pluginToolsets = [...pluginToolsets, ...mcpToolsets];

/** Built here (not inside `buildApp`) so this `TriggerRegistry` observes the same execution-
 *  completion events flow routes publish through it — see `app.ts`'s `hub` option. */
const hub = new ExecutionHub();
const discordBotToken = process.env["DISCORD_BOT_TOKEN"];
const triggerRegistry = new TriggerRegistry({
  db: opened.db,
  hub,
  scheduler: schedulerRegistry,
  pluginToolsets,
  discordClient: discordClientFromEnv(),
  discordBotToken,
  ...(process.env["DISCORD_RECOVERY_WINDOW_SECONDS"]
    ? { recoveryWindowSeconds: Number(process.env["DISCORD_RECOVERY_WINDOW_SECONDS"]) }
    : {}),
  ...(process.env["DISCORD_RECOVERY_LIMIT"] ? { recoveryLimit: Number(process.env["DISCORD_RECOVERY_LIMIT"]) } : {}),
});

const app = buildApp({
  db: opened.db,
  credentialKey,
  schedulerRegistry,
  staticRoot,
  spotifyConfig,
  pluginToolsets,
  pluginManifests,
  mcpStatuses,
  hub,
  triggerRegistry,
});

app.listen({ port, host: "127.0.0.1" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`flowlathe server listening on ${address}`);
});

/** Trigger startup happens *after* the app is listening — a slow or failing Discord gateway
 *  connection must never prevent the server from serving the UI (CLAUDE.md's MCP-discovery
 *  precedent, extended: that one blocks boot because it's synchronous with the tool registry the
 *  first request needs; a trigger has no such dependency, so there's no reason to make anyone
 *  wait on it). A trigger that fails to start is logged, not fatal to the others. */
for (const trigger of listTriggers(opened.db).filter((t) => t.enabled)) {
  triggerRegistry.start(trigger).catch((err: unknown) => {
    console.error(`[triggers] failed to start trigger "${trigger.id}": ${(err as Error).message}`);
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    triggerRegistry
      .stopAll()
      .catch(() => undefined)
      .then(() => app.close())
      .catch(() => undefined)
      .finally(() => {
        opened.close();
        process.exit(0);
      });
  });
}
