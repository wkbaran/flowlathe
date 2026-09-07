import type { PluginManifest } from "@flowlathe/core";

export const SEARXNG_MANIFEST: PluginManifest = {
  toolset: "searxng",
  displayName: "SearXNG",
  description: "Search the web via a self-hosted SearXNG metasearch instance.",
  env: [
    {
      name: "SEARXNG_BASE_URL",
      description: 'Base URL of a running SearXNG instance (aliased as "SEARXNG_URL" elsewhere, e.g. hermes-agent)',
      required: true,
      secret: false,
      docsUrl: "https://docs.searxng.org/",
    },
    { name: "SEARXNG_ENGINES", description: "Default comma-separated engine list", required: false, secret: false },
    { name: "SEARXNG_LANGUAGE", description: "Default search language", required: false, secret: false },
    { name: "SEARXNG_SAFESEARCH", description: "Default safesearch level (0, 1, or 2)", required: false, secret: false },
  ],
};
