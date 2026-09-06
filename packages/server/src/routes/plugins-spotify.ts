import { randomUUID } from "node:crypto";
import { buildAuthorizeUrl, exchangeCodeForToken, generatePkcePair, type SpotifyOAuthConfig } from "@flowlathe/plugin-spotify";
import { deletePluginCredential, hasPluginCredential, setPluginCredential, type Db } from "@flowlathe/persistence";
import type { FastifyInstance } from "fastify";

export interface SpotifyRouteDeps {
  db: Db;
  credentialKey: Buffer;
  /** Undefined when SPOTIFY_CLIENT_ID isn't set — routes report "not configured" instead of 500ing. */
  config: SpotifyOAuthConfig | undefined;
}

interface PendingAuth {
  verifier: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

export function registerSpotifyPluginRoutes(app: FastifyInstance, deps: SpotifyRouteDeps): void {
  const { db, credentialKey, config } = deps;
  /** Keyed by the OAuth `state` param, not persisted — a single-user local server restarting
   *  mid-flow just means the user clicks "Connect" again, which is an acceptable v1 tradeoff. */
  const pending = new Map<string, PendingAuth>();

  app.get("/api/plugins/spotify/status", async () => ({
    configured: config !== undefined,
    connected: hasPluginCredential(db, "spotify"),
  }));

  app.get("/api/plugins/spotify/oauth/start", async (_request, reply) => {
    if (!config) return reply.code(400).send({ error: "Spotify plugin is not configured (set SPOTIFY_CLIENT_ID)" });
    const pkce = generatePkcePair();
    const state = randomUUID();
    pending.set(state, { verifier: pkce.verifier, createdAt: Date.now() });
    return reply.redirect(buildAuthorizeUrl(config, pkce, state));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/plugins/spotify/oauth/callback",
    async (request, reply) => {
      if (!config) return reply.code(400).type("text/html").send(callbackPage("Spotify plugin is not configured."));
      const { code, state, error } = request.query;
      if (error) return reply.code(400).type("text/html").send(callbackPage(`Spotify authorization failed: ${error}`));
      if (!code || !state) return reply.code(400).type("text/html").send(callbackPage("Missing code or state."));

      const entry = pending.get(state);
      pending.delete(state);
      if (!entry || Date.now() - entry.createdAt > PENDING_TTL_MS) {
        return reply
          .code(400)
          .type("text/html")
          .send(callbackPage("This authorization link expired — go back and click Connect again."));
      }

      try {
        const tokens = await exchangeCodeForToken(config, code, entry.verifier);
        setPluginCredential(db, credentialKey, "spotify", tokens.refreshToken);
        return reply.type("text/html").send(callbackPage("Spotify connected — you can close this tab."));
      } catch (err) {
        return reply
          .code(500)
          .type("text/html")
          .send(callbackPage(`Failed to connect Spotify: ${(err as Error).message}`));
      }
    },
  );

  app.post("/api/plugins/spotify/disconnect", async (_request, reply) => {
    deletePluginCredential(db, "spotify");
    return reply.code(204).send();
  });
}

function callbackPage(message: string): string {
  return `<!doctype html><html><body style="font-family: sans-serif; padding: 2rem;"><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(s: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
  return s.replace(/[&<>"]/g, (c) => map[c] ?? c);
}
