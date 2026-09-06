import { readFileSync } from "node:fs";
import type { ToolRegistration } from "@flowlathe/core";
import { createMcpToolset, type McpServerConfig } from "@flowlathe/plugin-mcp";
import type { McpServerStatus } from "./routes/plugins-spotify.js";

interface McpServersFile {
  mcpServers?: Record<string, McpServerConfig>;
}

/** Reads the same `{ "mcpServers": { "<name>": {...} } }` shape Claude Desktop/Code use for
 *  their own MCP server config, so an operator can often point at a file they already have. */
export function loadMcpServersConfig(path: string): Record<string, McpServerConfig> {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as McpServersFile;
  return parsed.mcpServers ?? {};
}

export interface McpBootstrapResult {
  toolsets: ToolRegistration[];
  statuses: Record<string, McpServerStatus>;
}

/**
 * Discovers every configured MCP server's tools once, at boot — never per-run — so a slow or
 * unreachable server doesn't stall every prompt call with the toolset enabled (see
 * `@flowlathe/plugin-mcp`'s `createMcpToolset` doc comment). A server that fails discovery
 * contributes zero tool registrations rather than crashing the whole boot; its status is still
 * reported (see CLAUDE.md for the resulting "not configured" vs "configured but unreachable"
 * scope cut this implies for `findMissingToolsets`).
 */
export async function discoverMcpToolsets(
  servers: Record<string, McpServerConfig>,
  allowedCommandsCsv: string | undefined,
): Promise<McpBootstrapResult> {
  const results = await Promise.all(
    Object.entries(servers).map(async ([name, config]) => {
      try {
        const regs = await createMcpToolset(name, config, allowedCommandsCsv !== undefined ? { allowedCommandsCsv } : {});
        return { name, regs, error: undefined as string | undefined };
      } catch (err) {
        return { name, regs: [] as ToolRegistration[], error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const toolsets: ToolRegistration[] = [];
  const statuses: Record<string, McpServerStatus> = {};
  for (const { name, regs, error } of results) {
    toolsets.push(...regs);
    statuses[name] = error ? { connected: false, toolCount: 0, error } : { connected: true, toolCount: regs.length };
    if (error) console.warn(`[mcp] server "${name}" failed to connect: ${error}`);
  }
  return { toolsets, statuses };
}
