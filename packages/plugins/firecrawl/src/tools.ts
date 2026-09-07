import type { ToolInvokeMeta, ToolRegistration, ToolSpec } from "@flowlathe/core";
import { CachedLivenessProbe, requireString, toolFail, toolOk } from "@flowlathe/plugin-common";
import { FirecrawlClient, type ScrapeOutcome } from "./client.js";

export const FIRECRAWL_SCRAPE_TOOL: ToolSpec = {
  name: "firecrawl_scrape",
  description: "Fetch and extract the readable content of a single web page.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "page URL to scrape" },
      format: { type: "string", description: '"markdown" (default) or "html"' },
      onlyMainContent: { type: "boolean", description: "strip nav/ads/footers (default true)" },
    },
    required: ["url"],
  },
};

export const FIRECRAWL_CRAWL_TOOL: ToolSpec = {
  name: "firecrawl_crawl",
  description: "Crawl a site starting from a URL and extract content from each page found.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "starting URL" },
      limit: { type: "number", description: "max pages to crawl (default 10)" },
      maxDepth: { type: "number", description: "max link depth from the starting URL" },
      includePaths: { type: "string", description: "comma-separated URL path patterns to restrict the crawl to" },
    },
    required: ["url"],
  },
};

export const FIRECRAWL_MAP_TOOL: ToolSpec = {
  name: "firecrawl_map",
  description: "Cheaply discover which URLs exist on a site, without fetching their content.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "site URL" },
      search: { type: "string", description: "optional search term to filter discovered URLs" },
    },
    required: ["url"],
  },
};

function outcomeSummary(outcome: ScrapeOutcome): Record<string, unknown> {
  return outcome.error !== undefined
    ? { url: outcome.url, error: outcome.error }
    : { url: outcome.url, title: outcome.title, content: outcome.content };
}

function scrapeTool(client: FirecrawlClient): ToolRegistration["handler"] {
  return async (args, meta: ToolInvokeMeta) => {
    let url: string;
    try {
      url = requireString(args, "url");
    } catch (err) {
      return toolFail((err as Error).message);
    }
    const format = args["format"] === "html" ? "html" : "markdown";
    const outcome = await client.scrapeOne(
      url,
      { formats: [format], onlyMainContent: args["onlyMainContent"] !== false },
      meta.signal,
    );
    return outcome.error !== undefined ? toolFail(outcome.error) : toolOk(outcomeSummary(outcome));
  };
}

function crawlTool(client: FirecrawlClient): ToolRegistration["handler"] {
  return async (args, meta: ToolInvokeMeta) => {
    let url: string;
    try {
      url = requireString(args, "url");
    } catch (err) {
      return toolFail((err as Error).message);
    }
    const includePaths =
      typeof args["includePaths"] === "string"
        ? args["includePaths"]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;
    const limit = Number(args["limit"]);
    const maxDepth = Number(args["maxDepth"]);
    const outcomes = await client.crawl(
      url,
      {
        ...(Number.isFinite(limit) ? { limit } : {}),
        ...(Number.isFinite(maxDepth) ? { maxDepth } : {}),
        ...(includePaths && includePaths.length > 0 ? { includePaths } : {}),
      },
      meta.signal,
    );
    // Per-URL failures ride inside the array (never a whole-batch failure) — always toolOk here.
    return toolOk(outcomes.map(outcomeSummary));
  };
}

function mapTool(client: FirecrawlClient): ToolRegistration["handler"] {
  return async (args, meta: ToolInvokeMeta) => {
    let url: string;
    try {
      url = requireString(args, "url");
    } catch (err) {
      return toolFail((err as Error).message);
    }
    const search = typeof args["search"] === "string" ? args["search"] : undefined;
    const result = await client.map(url, search !== undefined ? { search } : {}, meta.signal);
    return "error" in result ? toolFail(result.error) : toolOk(result.urls);
  };
}

export function createFirecrawlToolset(client: FirecrawlClient): ToolRegistration[] {
  const liveness = new CachedLivenessProbe(() => client.isAuthorized());
  const unavailableReason = () => (liveness.isReachable() ? undefined : `Firecrawl at ${client.baseUrl} is not authorized or reachable`);
  const standalone = {
    module: "@flowlathe/plugin-firecrawl",
    factory: "firecrawlToolsetFromEnv",
    env: ["FIRECRAWL_API_KEY", "FIRECRAWL_BASE_URL", "FIRECRAWL_CRAWL_TIMEOUT_MS", "FLOWLATHE_ALLOW_PRIVATE_URLS"],
  };
  return [
    { toolset: "firecrawl", spec: FIRECRAWL_SCRAPE_TOOL, handler: scrapeTool(client), unavailableReason, standalone },
    { toolset: "firecrawl", spec: FIRECRAWL_CRAWL_TOOL, handler: crawlTool(client), unavailableReason, standalone },
    { toolset: "firecrawl", spec: FIRECRAWL_MAP_TOOL, handler: mapTool(client), unavailableReason, standalone },
  ];
}
