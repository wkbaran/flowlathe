import { describe, expect, it, vi } from "vitest";
import { SpotifyAuthRequiredError, SpotifyClient, SpotifyError, type SpotifyTokenStore } from "./client.js";

const config = { clientId: "client-123", redirectUri: "http://127.0.0.1:4310/callback" };

function memoryTokenStore(initial?: string): SpotifyTokenStore {
  let token = initial;
  return {
    getRefreshToken: () => token,
    saveRefreshToken: (t) => {
      token = t;
    },
  };
}

function fakeSpotifyFetch(opts: {
  onRefresh?: () => { access_token: string; refresh_token?: string; expires_in: number };
  onApi?: (url: URL, init: RequestInit) => Response;
}): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "accounts.spotify.com") {
      const body = opts.onRefresh?.() ?? { access_token: "at", expires_in: 3600 };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return opts.onApi?.(url, init ?? {}) ?? new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

describe("SpotifyClient", () => {
  it("throws SpotifyAuthRequiredError when never connected", async () => {
    const client = new SpotifyClient({ config, tokens: memoryTokenStore(), fetchImpl: fakeSpotifyFetch({}) });
    await expect(client.request("GET", "/me")).rejects.toThrow(SpotifyAuthRequiredError);
  });

  it("isConnected reflects whether a refresh token is stored", () => {
    expect(new SpotifyClient({ config, tokens: memoryTokenStore(), fetchImpl: fakeSpotifyFetch({}) }).isConnected()).toBe(
      false,
    );
    expect(
      new SpotifyClient({ config, tokens: memoryTokenStore("rt"), fetchImpl: fakeSpotifyFetch({}) }).isConnected(),
    ).toBe(true);
  });

  it("exchanges the refresh token for an access token and sends it as a bearer header", async () => {
    let sawAuth: string | undefined;
    const client = new SpotifyClient({
      config,
      tokens: memoryTokenStore("rt"),
      fetchImpl: fakeSpotifyFetch({
        onApi: (_url, init) => {
          sawAuth = (init.headers as Record<string, string>)["authorization"];
          return new Response(JSON.stringify({ id: "user-1" }), { status: 200 });
        },
      }),
    });
    const me = await client.request<{ id: string }>("GET", "/me");
    expect(me).toEqual({ id: "user-1" });
    expect(sawAuth).toBe("Bearer at");
  });

  it("caches the access token across calls instead of refreshing every time", async () => {
    let refreshCount = 0;
    const client = new SpotifyClient({
      config,
      tokens: memoryTokenStore("rt"),
      fetchImpl: fakeSpotifyFetch({
        onRefresh: () => {
          refreshCount++;
          return { access_token: "at", expires_in: 3600 };
        },
        onApi: () => new Response("{}", { status: 200 }),
      }),
    });
    await client.request("GET", "/me");
    await client.request("GET", "/me");
    expect(refreshCount).toBe(1);
  });

  it("retries once with a fresh token on a 401, then surfaces the retry's result", async () => {
    let apiCalls = 0;
    let refreshCount = 0;
    const client = new SpotifyClient({
      config,
      tokens: memoryTokenStore("rt"),
      fetchImpl: fakeSpotifyFetch({
        onRefresh: () => {
          refreshCount++;
          return { access_token: `at-${refreshCount}`, expires_in: 3600 };
        },
        onApi: () => {
          apiCalls++;
          return apiCalls === 1 ? new Response("unauthorized", { status: 401 }) : new Response("{}", { status: 200 });
        },
      }),
    });
    await client.request("GET", "/me");
    expect(apiCalls).toBe(2);
    expect(refreshCount).toBe(2);
  });

  it("saves a rotated refresh token back to the token store", async () => {
    const tokens = memoryTokenStore("old-rt");
    const client = new SpotifyClient({
      config,
      tokens,
      fetchImpl: fakeSpotifyFetch({
        onRefresh: () => ({ access_token: "at", refresh_token: "new-rt", expires_in: 3600 }),
        onApi: () => new Response("{}", { status: 200 }),
      }),
    });
    await client.request("GET", "/me");
    expect(tokens.getRefreshToken()).toBe("new-rt");
  });

  it("throws SpotifyError with the status and body on a non-2xx, non-401 response", async () => {
    const client = new SpotifyClient({
      config,
      tokens: memoryTokenStore("rt"),
      fetchImpl: fakeSpotifyFetch({ onApi: () => new Response("not found", { status: 404 }) }),
    });
    await expect(client.request("GET", "/me")).rejects.toThrow(SpotifyError);
    await expect(client.request("GET", "/me")).rejects.toThrow(/404/);
  });

  it("sends a JSON body and content-type header only when a body is given", async () => {
    let sawContentType: string | undefined;
    let sawBody: string | undefined;
    const client = new SpotifyClient({
      config,
      tokens: memoryTokenStore("rt"),
      fetchImpl: fakeSpotifyFetch({
        onApi: (_url, init) => {
          sawContentType = (init.headers as Record<string, string>)["content-type"];
          sawBody = init.body as string;
          return new Response("{}", { status: 200 });
        },
      }),
    });
    await client.request("POST", "/playlists/p1/tracks", { body: { uris: ["spotify:track:1"] } });
    expect(sawContentType).toBe("application/json");
    expect(sawBody).toBe(JSON.stringify({ uris: ["spotify:track:1"] }));
  });

  it("serializes query params, dropping undefined values", async () => {
    let sawUrl: URL | undefined;
    const client = new SpotifyClient({
      config,
      tokens: memoryTokenStore("rt"),
      fetchImpl: fakeSpotifyFetch({
        onApi: (url) => {
          sawUrl = url;
          return new Response("{}", { status: 200 });
        },
      }),
    });
    await client.request("GET", "/search", { query: { q: "abba", limit: 10, type: undefined } });
    expect(sawUrl?.searchParams.get("q")).toBe("abba");
    expect(sawUrl?.searchParams.get("limit")).toBe("10");
    expect(sawUrl?.searchParams.has("type")).toBe(false);
  });
});
