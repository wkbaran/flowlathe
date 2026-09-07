import type { ToolInvokeMeta, ToolRegistration, ToolSpec } from "@flowlathe/core";
import {
  CachedLivenessProbe,
  clampLimit,
  guarded,
  requireString,
  sanitizeUntrustedText,
  toolFail,
  toolOk,
} from "@flowlathe/plugin-common";
import { SearxngClient, type SearxngResult } from "./client.js";

export const SEARXNG_SEARCH_TOOL: ToolSpec = {
  name: "searxng_search",
  description: "Search the web via a self-hosted SearXNG metasearch instance.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "search text" },
      categories: { type: "string", description: 'comma-separated SearXNG categories, e.g. "general,news"' },
      engines: { type: "string", description: "comma-separated SearXNG engine names to restrict the search to" },
      limit: { type: "number", description: "max results, 1-20 (default 20)" },
      timeRange: { type: "string", description: '"day" | "month" | "year"' },
    },
    required: ["query"],
  },
};

export interface SearchResultSummary {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

/** A tool result (or a `search` node's output — see @flowlathe/node-search, which calls this
 *  same function so the two front ends stay identical) is prompt context, so trim SearXNG's raw
 *  response down to what a model needs — and sanitize each snippet/title, since search results
 *  are attacker-influenceable text landing directly in a model's context (same threat class as
 *  an MCP tool description). Exported rather than kept private for exactly that reuse. */
export function summarizeSearxngResults(results: SearxngResult[]): SearchResultSummary[] {
  return results.map((r) => ({
    title: sanitizeUntrustedText(r.title, 500, "searxng result"),
    url: r.url,
    snippet: sanitizeUntrustedText(r.content, 1000, "searxng result"),
    engine: r.engine,
  }));
}

function searxngSearchTool(client: SearxngClient): ToolRegistration["handler"] {
  return async (args, meta: ToolInvokeMeta) => {
    let query: string;
    try {
      query = requireString(args, "query");
    } catch (err) {
      return toolFail((err as Error).message);
    }
    const categories = typeof args["categories"] === "string" ? args["categories"] : undefined;
    const engines = typeof args["engines"] === "string" ? args["engines"] : undefined;
    const timeRange = typeof args["timeRange"] === "string" ? args["timeRange"] : undefined;
    const result = await guarded("searxng", "search", () =>
      client.search(
        query,
        {
          ...(categories !== undefined ? { categories } : {}),
          ...(engines !== undefined ? { engines } : {}),
          ...(timeRange !== undefined ? { timeRange } : {}),
          limit: clampLimit(args["limit"], 20, 20),
        },
        meta.signal,
      ),
    );
    return result.ok ? toolOk(summarizeSearxngResults(result.data)) : toolFail(result.error);
  };
}

export function createSearxngToolset(client: SearxngClient): ToolRegistration[] {
  const liveness = new CachedLivenessProbe(() => client.isReachable());
  return [
    {
      toolset: "searxng",
      spec: SEARXNG_SEARCH_TOOL,
      handler: searxngSearchTool(client),
      unavailableReason: () => (liveness.isReachable() ? undefined : `SearXNG at ${client.baseUrl} is not reachable`),
      standalone: {
        module: "@flowlathe/plugin-searxng",
        factory: "searxngToolsetFromEnv",
        env: ["SEARXNG_BASE_URL", "SEARXNG_ENGINES", "SEARXNG_LANGUAGE", "SEARXNG_SAFESEARCH"],
      },
    },
  ];
}
