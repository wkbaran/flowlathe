import { randomBytes } from "node:crypto";
import { ensureDefaultMockProvider, getPluginCredential, type OpenedDb, openDb, runMigrations } from "@flowlathe/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  vi.unstubAllGlobals();
});

function buildTestApp(spotifyConfig?: { clientId: string; redirectUri: string }) {
  const schedulerRegistry = new SchedulerRegistry(opened.db, credentialKey);
  return buildApp({ db: opened.db, credentialKey, schedulerRegistry, spotifyConfig });
}

describe("GET /api/plugins/spotify/status", () => {
  it("reports not configured and not connected with no SPOTIFY_CLIENT_ID", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/plugins/spotify/status" });
    expect(res.json()).toEqual({ configured: false, connected: false });
    await app.close();
  });

  it("reports configured once a client id is set, and connected once a credential exists", async () => {
    const app = buildTestApp({ clientId: "abc", redirectUri: "http://127.0.0.1:4310/api/plugins/spotify/oauth/callback" });
    expect((await app.inject({ method: "GET", url: "/api/plugins/spotify/status" })).json()).toEqual({
      configured: true,
      connected: false,
    });

    await app.inject({ method: "GET", url: "/api/plugins/spotify/oauth/start" });
    // status shouldn't flip to "connected" from merely starting the flow
    expect((await app.inject({ method: "GET", url: "/api/plugins/spotify/status" })).json().connected).toBe(false);
    await app.close();
  });
});

describe("GET /api/plugins/status", () => {
  it("aggregates known plugins by toolset name", async () => {
    const app = buildTestApp({ clientId: "abc", redirectUri: "http://127.0.0.1:4310/callback" });
    expect((await app.inject({ method: "GET", url: "/api/plugins/status" })).json()).toEqual({
      spotify: { configured: true, connected: false },
    });
    await app.close();
  });

  it("reports not configured when SPOTIFY_CLIENT_ID isn't set", async () => {
    const app = buildTestApp();
    expect((await app.inject({ method: "GET", url: "/api/plugins/status" })).json()).toEqual({
      spotify: { configured: false, connected: false },
    });
    await app.close();
  });
});

describe("GET /api/plugins/spotify/oauth/start", () => {
  it("400s when the plugin isn't configured", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/plugins/spotify/oauth/start" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("redirects to Spotify's authorize endpoint with client id + PKCE challenge", async () => {
    const app = buildTestApp({ clientId: "abc123", redirectUri: "http://127.0.0.1:4310/api/plugins/spotify/oauth/callback" });
    const res = await app.inject({ method: "GET", url: "/api/plugins/spotify/oauth/start" });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.origin + location.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(location.searchParams.get("client_id")).toBe("abc123");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("state")).toBeTruthy();
    await app.close();
  });
});

describe("GET /api/plugins/spotify/oauth/callback", () => {
  it("400s when the plugin isn't configured", async () => {
    const app = buildTestApp();
    const res = await app.inject({ method: "GET", url: "/api/plugins/spotify/oauth/callback?code=x&state=y" });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400s when code or state is missing", async () => {
    const app = buildTestApp({ clientId: "abc", redirectUri: "http://127.0.0.1:4310/callback" });
    const res = await app.inject({ method: "GET", url: "/api/plugins/spotify/oauth/callback" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("Missing code or state");
    await app.close();
  });

  it("400s on an unrecognized or already-consumed state", async () => {
    const app = buildTestApp({ clientId: "abc", redirectUri: "http://127.0.0.1:4310/callback" });
    const res = await app.inject({ method: "GET", url: "/api/plugins/spotify/oauth/callback?code=x&state=never-issued" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain("expired");
    await app.close();
  });

  it("exchanges the code, stores the refresh token, and reports connected afterwards", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 }),
      ),
    );
    const app = buildTestApp({ clientId: "abc", redirectUri: "http://127.0.0.1:4310/callback" });

    const start = await app.inject({ method: "GET", url: "/api/plugins/spotify/oauth/start" });
    const state = new URL(start.headers.location as string).searchParams.get("state");

    const callback = await app.inject({ method: "GET", url: `/api/plugins/spotify/oauth/callback?code=auth-code&state=${state}` });
    expect(callback.statusCode).toBe(200);
    expect(callback.body).toContain("connected");
    expect(getPluginCredential(opened.db, credentialKey, "spotify")).toBe("rt");

    const status = await app.inject({ method: "GET", url: "/api/plugins/spotify/status" });
    expect(status.json()).toEqual({ configured: true, connected: true });
    await app.close();
  });

  it("a state can't be replayed a second time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 }),
      ),
    );
    const app = buildTestApp({ clientId: "abc", redirectUri: "http://127.0.0.1:4310/callback" });
    const start = await app.inject({ method: "GET", url: "/api/plugins/spotify/oauth/start" });
    const state = new URL(start.headers.location as string).searchParams.get("state");
    const url = `/api/plugins/spotify/oauth/callback?code=auth-code&state=${state}`;

    expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(400);
    await app.close();
  });
});

describe("POST /api/plugins/spotify/disconnect", () => {
  it("deletes any stored credential and status reflects it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 }),
      ),
    );
    const app = buildTestApp({ clientId: "abc", redirectUri: "http://127.0.0.1:4310/callback" });
    const start = await app.inject({ method: "GET", url: "/api/plugins/spotify/oauth/start" });
    const state = new URL(start.headers.location as string).searchParams.get("state");
    await app.inject({ method: "GET", url: `/api/plugins/spotify/oauth/callback?code=x&state=${state}` });

    const disconnect = await app.inject({ method: "POST", url: "/api/plugins/spotify/disconnect" });
    expect(disconnect.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/plugins/spotify/status" })).json().connected).toBe(false);
    await app.close();
  });
});
