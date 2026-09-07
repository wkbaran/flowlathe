import { renderTemplate, type RuntimeHost } from "@flowlathe/core";
import { SearxngClient, summarizeSearxngResults } from "@flowlathe/plugin-searxng";
import type { SearchSpec } from "./schema.js";

export interface SearchResult {
  /** JSON-stringified array of `{title, url, snippet, engine}` — see
   *  `summarizeSearxngResults` (`@flowlathe/plugin-searxng`), the exact function the
   *  `searxng_search` tool uses, so the node and tool front ends stay identical. */
  results: string;
}

/**
 * Reads `SEARXNG_BASE_URL` (+ optional engines/language/safesearch defaults) directly from
 * `process.env`, exactly like the exported-script "standalone" path
 * (`searxngToolsetFromEnv` in @flowlathe/plugin-searxng) — this node package is imported by both
 * the live interpreter and the compiled script (via `@flowlathe/runtime`'s `createRun`, PLAN.md's
 * "one implementation, two callers"), and both run as Node processes with that env var already
 * set. `fetchImpl` is `ctx.net.fetch`, never the bare global, so the parity harness and unit
 * tests run fully offline against a stub (PLAN-INTEGRATIONS.md §5.3).
 */
function clientFromEnv(fetchImpl: typeof fetch): SearxngClient {
  const baseUrl = process.env["SEARXNG_BASE_URL"];
  if (!baseUrl) {
    throw new Error("SearXNG is not configured (set SEARXNG_BASE_URL)");
  }
  const safesearch = process.env["SEARXNG_SAFESEARCH"];
  return new SearxngClient({
    baseUrl,
    fetchImpl,
    ...(process.env["SEARXNG_ENGINES"] ? { defaultEngines: process.env["SEARXNG_ENGINES"] } : {}),
    ...(process.env["SEARXNG_LANGUAGE"] ? { defaultLanguage: process.env["SEARXNG_LANGUAGE"] } : {}),
    ...(safesearch !== undefined ? { defaultSafesearch: Number(safesearch) } : {}),
  });
}

export async function runSearch(ctx: RuntimeHost, spec: SearchSpec, inputs: Record<string, string>): Promise<SearchResult> {
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  const start = ctx.clock.now();
  const query = renderTemplate(spec.queryTemplate, inputs);
  try {
    const client = clientFromEnv(ctx.net.fetch);
    const results = await client.search(query, {
      ...(spec.categories !== undefined ? { categories: spec.categories } : {}),
      ...(spec.engines !== undefined ? { engines: spec.engines } : {}),
      ...(spec.timeRange !== undefined ? { timeRange: spec.timeRange } : {}),
      ...(spec.limit !== undefined ? { limit: spec.limit } : {}),
    });
    const output = JSON.stringify(summarizeSearxngResults(results));
    const latencyMs = ctx.clock.now() - start;
    ctx.emit({ kind: "node_finished", nodeId: spec.id, output, renderedPrompt: query, finishReason: "stop", latencyMs });
    return { results: output };
  } catch (err) {
    ctx.emit({ kind: "node_failed", nodeId: spec.id, error: (err as Error).message });
    throw err;
  }
}
