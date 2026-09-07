import type { PluginManifest, ToolRegistration } from "@flowlathe/core";
import type { FastifyInstance } from "fastify";

export interface McpServerStatus {
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface PluginRouteDeps {
  /** One manifest per plugin *package* compiled into this server — present regardless of
   *  whether that plugin is actually configured, so `/api/plugins/status` can report a friendly
   *  display name and setup instructions even for an unconfigured plugin (PLAN-INTEGRATIONS.md
   *  §2.3). Does NOT include one entry per MCP server — those are dynamic (config-file-driven)
   *  and folded in separately via `mcpStatuses`. */
  manifests: PluginManifest[];
  /** Every tool registration actually live on this server right now, across all plugins. Per
   *  the "unset env var ⇒ zero tool registrations" locked decision, a manifest's toolset has
   *  registrations here iff it's configured — so `configured`/`connected` are both derived from
   *  this list plus each registration's `unavailableReason()`, uniformly across plugins, with no
   *  per-plugin special-casing needed here. Spotify's OAuth-token liveness and SearXNG's cached
   *  HTTP probe both already flow through `unavailableReason()` for exactly this reason. */
  pluginToolsets: ToolRegistration[];
  /** MCP is the one exception to the uniform rule above: discovery happens once at boot, and a
   *  server that fails discovery contributes zero registrations — indistinguishable, by
   *  registration count alone, from "never configured" (see CLAUDE.md). `mcpStatuses` carries
   *  the real per-server outcome so the status route can still say "configured but unreachable". */
  mcpStatuses?: Record<string, McpServerStatus>;
}

export interface PluginStatusResponseEntry {
  configured: boolean;
  connected: boolean;
  displayName: string;
  description: string;
}

/** Generic status/manifest aggregate the canvas reads for both the workflow-dependency banner
 *  and the per-node toolset checkboxes — keyed by toolset name, so the UI needs no per-plugin
 *  code to render a new one (see Canvas.tsx). Plugin-specific routes (OAuth flows, etc.) live in
 *  their own files, e.g. `routes/plugins-spotify.ts`. */
export function registerPluginRoutes(app: FastifyInstance, deps: PluginRouteDeps): void {
  const { manifests, pluginToolsets, mcpStatuses } = deps;

  app.get("/api/plugins/status", async () => {
    const registrationsByToolset = new Map<string, ToolRegistration[]>();
    for (const reg of pluginToolsets) {
      registrationsByToolset.set(reg.toolset, [...(registrationsByToolset.get(reg.toolset) ?? []), reg]);
    }

    const result: Record<string, PluginStatusResponseEntry> = {};
    for (const manifest of manifests) {
      const regs = registrationsByToolset.get(manifest.toolset) ?? [];
      const configured = regs.length > 0;
      const connected = configured && regs.every((r) => !r.unavailableReason?.());
      result[manifest.toolset] = {
        configured,
        connected,
        displayName: manifest.displayName,
        description: manifest.description,
      };
    }

    for (const [name, status] of Object.entries(mcpStatuses ?? {})) {
      result[`mcp:${name}`] = {
        configured: true,
        connected: status.connected,
        displayName: `${name} (MCP)`,
        description: status.error ? `MCP server "${name}": ${status.error}` : `MCP server "${name}" (${status.toolCount} tools)`,
      };
    }

    return result;
  });
}
