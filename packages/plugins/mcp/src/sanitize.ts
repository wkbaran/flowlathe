/**
 * An MCP server's tool names/descriptions are untrusted text landing directly in a model's
 * context (an MCP server is an arbitrary process or URL the operator configured — flowlathe
 * itself never wrote this text). A malicious or compromised server can try to inject
 * instructions into a description ("IGNORE ALL PREVIOUS INSTRUCTIONS...") hoping the model
 * treats it as a system directive rather than tool metadata. This module can't stop a
 * sufficiently novel injection, but it strips the cheap tricks (hidden/control characters,
 * unbounded length) and flags the loud ones (see PLAN.md's "port Flowise's sanitization").
 */

const DEFAULT_TOOL_NAME_MAX_LENGTH = 128;
const DEFAULT_TOOL_DESCRIPTION_MAX_LENGTH = 1024;

/** Loud, common prompt-injection phrasing. Not exhaustive — a warning, not a guarantee. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\bCRITICAL\b/,
  /\bMANDATORY\b/,
  /\bYOU\s+MUST\b/i,
  /\bMUST\s+(?:call|use|invoke|execute|run|send)\b/i,
  /ignore\s+(?:previous|all|above|prior)\s+(?:instructions?|prompts?|rules?)/i,
  /disregard\s+(?:the\s+)?(?:above|previous|prior|system)/i,
  /override\s+(?:the\s+)?(?:system|prompt|instructions?)/i,
  /forget\s+(?:your|the|all)\s+(?:instructions?|prompts?|rules?)/i,
  /before\s+(?:using|calling|invoking)\s+any\s+other/i,
  /call\s+this\s+tool\s+first/i,
  /send\s+(?:the\s+)?user(?:'s|s)?\s+(?:message|input|data|conversation)/i,
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Zero-width and bidi-override characters used to hide text from a human reviewer:
 *  ZWSP/ZWNJ/ZWJ (U+200B-200D), line/paragraph separators (U+2028-2029), bidi overrides
 *  (U+202A-202E), word joiner (U+2060), BOM/zero-width-no-break-space (U+FEFF). Built from
 *  numeric code points rather than a regex literal, so this file's source never has to embed
 *  the actual invisible characters it's trying to strip. */
const HIDDEN_CHAR_RANGES: readonly [number, number][] = [
  [0x200b, 0x200d],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
];
const HIDDEN_CHARS = new RegExp(
  `[${HIDDEN_CHAR_RANGES.map(([start, end]) => `\\u{${start.toString(16)}}-\\u{${end.toString(16)}}`).join("")}]`,
  "gu",
);

function stripHiddenChars(text: string): string {
  return text.replace(CONTROL_CHARS, "").replace(HIDDEN_CHARS, "");
}

export function sanitizeMcpToolDescription(description: string, maxLength = DEFAULT_TOOL_DESCRIPTION_MAX_LENGTH): string {
  let cleaned = stripHiddenChars(description);
  if (cleaned.length > maxLength) cleaned = cleaned.slice(0, maxLength);
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      console.warn(
        `[mcp] suspicious instruction-injection pattern in tool description (matched ${pattern}): "${cleaned.slice(0, 120)}"`,
      );
      break;
    }
  }
  return cleaned;
}

/** MCP tool names reach providers as `ToolSpec.name`, which both adapters send through
 *  essentially verbatim — constrain to a safe identifier charset so a malformed/malicious
 *  server can't smuggle control characters or excessive length into a provider request. */
export function sanitizeMcpToolName(name: string, maxLength = DEFAULT_TOOL_NAME_MAX_LENGTH): string {
  const trimmed = name.trim();
  const cleaned = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, maxLength);
  if (cleaned !== trimmed) {
    console.warn(`[mcp] tool name sanitized from "${name.slice(0, 64)}" to "${cleaned.slice(0, 64)}"`);
  }
  return cleaned;
}
