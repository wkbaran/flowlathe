import { createHash, randomBytes } from "node:crypto";

export interface SpotifyOAuthConfig {
  clientId: string;
  redirectUri: string;
}

/** playlist read/modify + library read/modify only — this plugin doesn't do playback control,
 *  so it never requests the player scopes. */
export const SPOTIFY_SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-library-read",
  "user-library-modify",
];

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** RFC 7636 PKCE: a public client (no client secret) proves it holds the verifier that produced
 *  the challenge it sent up front, so an intercepted authorization code alone can't be redeemed. */
export function generatePkcePair(): PkcePair {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildAuthorizeUrl(config: SpotifyOAuthConfig, pkce: PkcePair, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: config.redirectUri,
    code_challenge_method: "S256",
    code_challenge: pkce.challenge,
    state,
    scope: SPOTIFY_SCOPES.join(" "),
  });
  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

interface SpotifyTokenResponseBody {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

async function postToken(body: URLSearchParams, fetchImpl: typeof fetch): Promise<SpotifyTokenResponseBody> {
  const res = await fetchImpl("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Spotify token request failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as SpotifyTokenResponseBody;
}

export async function exchangeCodeForToken(
  config: SpotifyOAuthConfig,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResult> {
  const json = await postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: verifier,
    }),
    fetchImpl,
  );
  if (!json.refresh_token) throw new Error("Spotify token exchange did not return a refresh_token");
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresInSeconds: json.expires_in };
}

/** Spotify's refresh grant only sometimes rotates the refresh token — when it doesn't, the
 *  response simply omits `refresh_token`, and the caller must keep using the one it already has.
 *  Takes `fetchImpl` (rather than always using the global fetch) so SpotifyClient can route this
 *  call through the same overridable fetch its API calls use — otherwise a test that swaps in a
 *  fake fetch for the client would still hit the real network for token refresh. */
export async function refreshAccessToken(
  config: SpotifyOAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResult> {
  const json = await postToken(
    new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: config.clientId }),
    fetchImpl,
  );
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? refreshToken,
    expiresInSeconds: json.expires_in,
  };
}
