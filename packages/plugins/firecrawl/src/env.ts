import type { ToolRegistration } from "@flowlathe/core";
import { FirecrawlClient } from "./client.js";
import { createFirecrawlToolset } from "./tools.js";

/** `undefined` when `FIRECRAWL_API_KEY` isn't set — the secure default: unset env var, zero tool
 *  registrations. */
export function firecrawlClientFromEnv(env: NodeJS.ProcessEnv = process.env): FirecrawlClient | undefined {
  const apiKey = env["FIRECRAWL_API_KEY"];
  if (!apiKey) return undefined;
  const crawlTimeoutMs = env["FIRECRAWL_CRAWL_TIMEOUT_MS"];
  return new FirecrawlClient({
    apiKey,
    ...(env["FIRECRAWL_BASE_URL"] ? { baseUrl: env["FIRECRAWL_BASE_URL"] } : {}),
    ...(crawlTimeoutMs !== undefined ? { crawlTimeoutMs: Number(crawlTimeoutMs) } : {}),
    allowPrivateUrls: env["FLOWLATHE_ALLOW_PRIVATE_URLS"] === "1",
  });
}

/** Named export a compiled, exported script calls to reconstruct this toolset from environment
 *  alone — see `ToolRegistration.standalone` and PLAN-INTEGRATIONS.md §4.4. Used the same way by
 *  the live server (`packages/server/src/index.ts`). */
export function firecrawlToolsetFromEnv(env: NodeJS.ProcessEnv = process.env): ToolRegistration[] {
  const client = firecrawlClientFromEnv(env);
  return client ? createFirecrawlToolset(client) : [];
}
