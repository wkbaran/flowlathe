import type { ToolRegistration } from "@flowlathe/core";
import { McpClient, type McpServerConfig } from "./client.js";
import { sanitizeMcpToolDescription, sanitizeMcpToolName } from "./sanitize.js";

export interface CreateMcpToolsetOptions {
  /** Comma-separated command allowlist for stdio servers — see `validateStdioServerConfig`. */
  allowedCommandsCsv?: string;
}

/**
 * Discovers an MCP server's tools once (via `tools/list`) and returns one `ToolRegistration`
 * per tool, grouped under the toolset `mcp:<name>` — `name` is the key the operator gave this
 * server in the `mcpServers` config, so a flow author opts into it the same way as any other
 * toolset, via `PromptSpec.enabledToolsets`.
 *
 * Discovery happens once, at registration time (server boot, or whenever the config is
 * reloaded) — not per-invocation — so a server that's slow or briefly unreachable doesn't stall
 * every prompt call that merely has the toolset enabled; only actually *invoking* one of its
 * tools pays a fresh connection. If discovery itself fails, this throws rather than returning
 * an empty toolset, so the caller can log which server failed and why (see
 * `packages/server/src/index.ts`); a server with zero registrations is otherwise
 * indistinguishable from one the operator never configured — see CLAUDE.md for this v1 scope
 * cut.
 */
export async function createMcpToolset(
  name: string,
  config: McpServerConfig,
  opts: CreateMcpToolsetOptions = {},
): Promise<ToolRegistration[]> {
  const client = new McpClient(config, opts.allowedCommandsCsv !== undefined ? { allowedCommandsCsv: opts.allowedCommandsCsv } : {});
  const tools = await client.listTools();
  const toolset = `mcp:${name}`;

  return tools.map((tool) => {
    const safeName = sanitizeMcpToolName(tool.name);
    const safeDescription = sanitizeMcpToolDescription(tool.description);
    return {
      toolset,
      spec: {
        name: safeName,
        description: safeDescription,
        parameters: { type: "object", properties: tool.inputSchema.properties ?? {}, ...(tool.inputSchema.required ? { required: tool.inputSchema.required } : {}) },
      },
      // Invoke against the MCP server's original (unsanitized) tool name — sanitization only
      // ever changes what's exposed to the model, never what's sent over the wire to the server.
      handler: async (args) => {
        try {
          return await client.callTool(tool.name, args);
        } catch (err) {
          return `[${safeName}]: error - ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    };
  });
}
