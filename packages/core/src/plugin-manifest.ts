/**
 * A declarative descriptor for a plugin's setup requirements, alongside its `ToolRegistration`s.
 * Generalizes the ad hoc "Spotify has a Connect button, everything else is a bare
 * {configured, connected} pair" split that `/api/plugins/status` started with — see
 * PLAN-INTEGRATIONS.md §2.3. The canvas renders the workflow-dependency banner and per-node
 * toolset checkboxes from this data (`displayName`), rather than special-casing toolset name
 * prefixes (the old `mcp:` string test in Canvas.tsx).
 */
export interface PluginManifestEnvVar {
  name: string;
  description: string;
  required: boolean;
  secret: boolean;
  docsUrl?: string;
}

export interface PluginManifest {
  /** Matches `ToolRegistration.toolset` for this plugin's tools, e.g. "searxng", "firecrawl",
   *  "discord", "spotify", or "mcp:<server-name>" for a configured MCP server. */
  toolset: string;
  displayName: string;
  description: string;
  env: PluginManifestEnvVar[];
  /** Present only for a plugin needing an interactive grant (Spotify's OAuth dance). Absent for
   *  a plugin configured entirely by env vars / static secret (SearXNG, Firecrawl, Discord, MCP). */
  connect?: { startPath: string; disconnectPath: string };
}

export interface PluginStatusEntry {
  manifest: PluginManifest;
  configured: boolean;
  connected: boolean;
}
