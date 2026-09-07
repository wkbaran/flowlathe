import { sanitizeUntrustedText } from "@flowlathe/plugin-common";

/**
 * An MCP server's tool names/descriptions are untrusted text landing directly in a model's
 * context (an MCP server is an arbitrary process or URL the operator configured — flowlathe
 * itself never wrote this text). A malicious or compromised server can try to inject
 * instructions into a description ("IGNORE ALL PREVIOUS INSTRUCTIONS...") hoping the model
 * treats it as a system directive rather than tool metadata. The actual stripping/flagging logic
 * lives in `@flowlathe/plugin-common`'s `sanitizeUntrustedText` (generalized from here per
 * PLAN-INTEGRATIONS.md §3, since SearXNG/Firecrawl/Discord all land untrusted text in context too).
 */

const DEFAULT_TOOL_NAME_MAX_LENGTH = 128;
const DEFAULT_TOOL_DESCRIPTION_MAX_LENGTH = 1024;

export function sanitizeMcpToolDescription(description: string, maxLength = DEFAULT_TOOL_DESCRIPTION_MAX_LENGTH): string {
  return sanitizeUntrustedText(description, maxLength, "mcp");
}

/** MCP tool names reach providers as `ToolSpec.name`, which both adapters send through
 *  essentially verbatim — constrain to a safe identifier charset so a malformed/malicious
 *  server can't smuggle control characters or excessive length into a provider request. Kept
 *  here rather than in the shared module: this is an identifier-charset constraint, not the
 *  hidden-char/injection-pattern concern `sanitizeUntrustedText` addresses. */
export function sanitizeMcpToolName(name: string, maxLength = DEFAULT_TOOL_NAME_MAX_LENGTH): string {
  const trimmed = name.trim();
  const cleaned = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLength);
  if (cleaned !== trimmed) {
    console.warn(`[mcp] tool name sanitized from "${name.slice(0, 64)}" to "${cleaned.slice(0, 64)}"`);
  }
  return cleaned;
}
