import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthorizeUrl, exchangeCodeForToken, generatePkcePair, refreshAccessToken } from "./oauth.js";

const config = { clientId: "client-123", redirectUri: "http://127.0.0.1:4310/api/plugins/spotify/oauth/callback" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generatePkcePair", () => {
  it("produces a verifier and a distinct S256-derived challenge, both URL-safe", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).not.toBe(challenge);
    for (const value of [verifier, challenge]) {
      expect(value).not.toMatch(/[+/=]/);
    }
  });

  it("generates a different pair every call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  it("embeds the client id, redirect uri, challenge, and state as query params", () => {
    const pkce = generatePkcePair();
    const url = new URL(buildAuthorizeUrl(config, pkce, "state-abc"));
    expect(url.origin + url.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(url.searchParams.get("client_id")).toBe("client-123");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("code_challenge")).toBe(pkce.challenge);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("scope")).toContain("playlist-read-private");
  });
});

describe("exchangeCodeForToken", () => {
  it("posts the authorization code + verifier and returns the parsed tokens", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = new URLSearchParams(init.body as string);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("auth-code");
      expect(body.get("code_verifier")).toBe("verifier-xyz");
      return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeCodeForToken(config, "auth-code", "verifier-xyz");
    expect(result).toEqual({ accessToken: "at", refreshToken: "rt", expiresInSeconds: 3600 });
  });

  it("throws when Spotify's response has no refresh_token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "at", expires_in: 3600 }), { status: 200 })),
    );
    await expect(exchangeCodeForToken(config, "code", "verifier")).rejects.toThrow(/refresh_token/);
  });

  it("throws with the response body on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("invalid_grant", { status: 400 })));
    await expect(exchangeCodeForToken(config, "code", "verifier")).rejects.toThrow(/400/);
  });
});

describe("refreshAccessToken", () => {
  it("keeps the old refresh token when Spotify doesn't rotate it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ access_token: "new-at", expires_in: 3600 }), { status: 200 })),
    );
    const result = await refreshAccessToken(config, "old-rt");
    expect(result).toEqual({ accessToken: "new-at", refreshToken: "old-rt", expiresInSeconds: 3600 });
  });

  it("adopts a rotated refresh token when Spotify sends one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 3600 }), {
            status: 200,
          }),
      ),
    );
    const result = await refreshAccessToken(config, "old-rt");
    expect(result.refreshToken).toBe("new-rt");
  });
});
