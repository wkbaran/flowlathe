import type { PluginManifest } from "@flowlathe/core";

export const FIRECRAWL_MANIFEST: PluginManifest = {
  toolset: "firecrawl",
  displayName: "Firecrawl",
  description: "Scrape, crawl, and discover URLs on the web (cloud or self-hosted Firecrawl).",
  env: [
    {
      name: "FIRECRAWL_API_KEY",
      description: "Firecrawl API key",
      required: true,
      secret: true,
      docsUrl: "https://docs.firecrawl.dev/",
    },
    {
      name: "FIRECRAWL_BASE_URL",
      description: "Base URL of a self-hosted Firecrawl instance (defaults to Firecrawl's cloud API)",
      required: false,
      secret: false,
    },
  ],
};
