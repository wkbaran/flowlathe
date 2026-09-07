import type { ToolRegistration } from "@flowlathe/core";
import { SearxngClient } from "./client.js";
import { createSearxngToolset } from "./tools.js";

/** `undefined` when `SEARXNG_BASE_URL` isn't set — the secure default (mirrors
 *  `SPOTIFY_CLIENT_ID`/`MCP_ALLOWED_COMMANDS`): unset env var, zero tool registrations. */
export function searxngClientFromEnv(env: NodeJS.ProcessEnv = process.env): SearxngClient | undefined {
  const baseUrl = env["SEARXNG_BASE_URL"];
  if (!baseUrl) return undefined;
  const safesearch = env["SEARXNG_SAFESEARCH"];
  return new SearxngClient({
    baseUrl,
    ...(env["SEARXNG_ENGINES"] ? { defaultEngines: env["SEARXNG_ENGINES"] } : {}),
    ...(env["SEARXNG_LANGUAGE"] ? { defaultLanguage: env["SEARXNG_LANGUAGE"] } : {}),
    ...(safesearch !== undefined ? { defaultSafesearch: Number(safesearch) } : {}),
  });
}

/** Named export a compiled, exported script calls to reconstruct this toolset from environment
 *  alone — see `ToolRegistration.standalone` and PLAN-INTEGRATIONS.md §4.4. Used the same way by
 *  the live server (`packages/server/src/index.ts`). */
export function searxngToolsetFromEnv(env: NodeJS.ProcessEnv = process.env): ToolRegistration[] {
  const client = searxngClientFromEnv(env);
  return client ? createSearxngToolset(client) : [];
}
