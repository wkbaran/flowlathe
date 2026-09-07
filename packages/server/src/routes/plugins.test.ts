import { randomBytes } from "node:crypto";
import { createSpotifyToolset, SpotifyClient, SPOTIFY_MANIFEST, type SpotifyOAuthConfig } from "@flowlathe/plugin-spotify";
import { ensureDefaultMockProvider, openDb, runMigrations, type OpenedDb } from "@flowlathe/persistence";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { SchedulerRegistry } from "../scheduler-registry.js";

let opened: OpenedDb;
let credentialKey: Buffer;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  ensureDefaultMockProvider(opened.db);
  credentialKey = randomBytes(32);
});

afterEach(() => {
  opened.close();
});

function buildTestApp(opts: { spotifyConfigured?: boolean; connected?: boolean } = {}) {
  const schedulerRegistry = new SchedulerRegistry(opened.db, credentialKey);
  const spotifyConfig: SpotifyOAuthConfig | undefined = opts.spotifyConfigured
    ? { clientId: "abc", redirectUri: "http://127.0.0.1:4310/callback" }
    : undefined;
  let pluginToolsets: ReturnType<typeof createSpotifyToolset> = [];
  if (spotifyConfig) {
    const client = new SpotifyClient({
      config: spotifyConfig,
      tokens: {
        getRefreshToken: () => (opts.connected ? "refresh-token" : undefined),
        saveRefreshToken: () => undefined,
      },
    });
    pluginToolsets = createSpotifyToolset(client);
  }
  return buildApp({
    db: opened.db,
    credentialKey,
    schedulerRegistry,
    spotifyConfig,
    pluginToolsets,
    pluginManifests: [SPOTIFY_MANIFEST],
  });
}

describe("GET /api/plugins/status", () => {
  it("reports not configured when no plugin is set up", async () => {
    const app = buildTestApp();
    expect((await app.inject({ method: "GET", url: "/api/plugins/status" })).json()).toEqual({
      spotify: { configured: false, connected: false, displayName: "Spotify", description: SPOTIFY_MANIFEST.description },
    });
    await app.close();
  });

  it("reports configured-but-not-connected once a client id is set with no credential", async () => {
    const app = buildTestApp({ spotifyConfigured: true });
    expect((await app.inject({ method: "GET", url: "/api/plugins/status" })).json()).toEqual({
      spotify: { configured: true, connected: false, displayName: "Spotify", description: SPOTIFY_MANIFEST.description },
    });
    await app.close();
  });

  it("reports connected once a refresh token exists", async () => {
    const app = buildTestApp({ spotifyConfigured: true, connected: true });
    expect((await app.inject({ method: "GET", url: "/api/plugins/status" })).json()).toEqual({
      spotify: { configured: true, connected: true, displayName: "Spotify", description: SPOTIFY_MANIFEST.description },
    });
    await app.close();
  });

  it("folds MCP server statuses in, keyed by mcp:<name>, alongside static plugin manifests", async () => {
    const app = buildApp({
      db: opened.db,
      credentialKey,
      schedulerRegistry: new SchedulerRegistry(opened.db, credentialKey),
      pluginManifests: [SPOTIFY_MANIFEST],
      mcpStatuses: { myserver: { connected: true, toolCount: 2 } },
    });
    const json = (await app.inject({ method: "GET", url: "/api/plugins/status" })).json() as Record<string, unknown>;
    expect(json["mcp:myserver"]).toEqual({
      configured: true,
      connected: true,
      displayName: "myserver (MCP)",
      description: 'MCP server "myserver" (2 tools)',
    });
    await app.close();
  });

  it("reports a failed MCP discovery as configured but not connected, with its error in the description", async () => {
    const app = buildApp({
      db: opened.db,
      credentialKey,
      schedulerRegistry: new SchedulerRegistry(opened.db, credentialKey),
      pluginManifests: [SPOTIFY_MANIFEST],
      mcpStatuses: { flaky: { connected: false, toolCount: 0, error: "connection refused" } },
    });
    const json = (await app.inject({ method: "GET", url: "/api/plugins/status" })).json() as Record<string, unknown>;
    expect(json["mcp:flaky"]).toEqual({
      configured: true,
      connected: false,
      displayName: "flaky (MCP)",
      description: 'MCP server "flaky": connection refused',
    });
    await app.close();
  });
});
