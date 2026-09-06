import { refreshAccessToken, type SpotifyOAuthConfig } from "./oauth.js";

export class SpotifyError extends Error {}

export class SpotifyAuthRequiredError extends SpotifyError {
  constructor() {
    super("Spotify is not connected — connect it from the Plugins section before using this tool.");
  }
}

/** Persistence-agnostic: the client only ever sees a refresh token, never how/where it's stored
 *  (see @flowlathe/persistence's plugin-credentials for the encrypted-at-rest side of this). */
export interface SpotifyTokenStore {
  getRefreshToken(): string | undefined;
  saveRefreshToken(token: string): void;
}

export interface SpotifyClientOptions {
  config: SpotifyOAuthConfig;
  tokens: SpotifyTokenStore;
  /** Overridable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface SpotifyRequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

const API_BASE = "https://api.spotify.com/v1";

/** Caches the access token in memory only, for this process's lifetime — refreshed lazily from
 *  the stored refresh token, same pattern Hermes's plugin client uses. One 401 retry covers the
 *  case where Spotify invalidates a token before our cached expiry says it should. */
export class SpotifyClient {
  private readonly config: SpotifyOAuthConfig;
  private readonly tokens: SpotifyTokenStore;
  private readonly fetchImpl: typeof fetch;
  private accessToken: string | undefined;
  private accessTokenExpiresAt = 0;

  constructor(opts: SpotifyClientOptions) {
    this.config = opts.config;
    this.tokens = opts.tokens;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  isConnected(): boolean {
    return this.tokens.getRefreshToken() !== undefined;
  }

  private async getAccessToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }
    const refreshToken = this.tokens.getRefreshToken();
    if (!refreshToken) throw new SpotifyAuthRequiredError();
    const result = await refreshAccessToken(this.config, refreshToken, this.fetchImpl);
    this.accessToken = result.accessToken;
    this.accessTokenExpiresAt = Date.now() + Math.max(0, result.expiresInSeconds - 60) * 1000;
    if (result.refreshToken !== refreshToken) this.tokens.saveRefreshToken(result.refreshToken);
    return this.accessToken;
  }

  async request<T>(method: string, path: string, opts: SpotifyRequestOptions = {}): Promise<T> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const send = async (accessToken: string) => {
      const init: RequestInit = {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        },
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      return this.fetchImpl(url.toString(), init);
    };

    let res = await send(await this.getAccessToken());
    if (res.status === 401) {
      res = await send(await this.getAccessToken(true));
    }
    return handleResponse<T>(res);
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    throw new SpotifyError(`Spotify API error ${res.status}: ${text || res.statusText}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}
