/**
 * Untrusted text landing in a model's context — an MCP tool description, a SearXNG search
 * result snippet, a scraped web page, a Discord message someone else sent — can't be trusted not
 * to contain a prompt-injection attempt or hidden characters. This module can't stop a
 * sufficiently novel injection, but it strips the cheap tricks (hidden/control characters,
 * unbounded length) and flags the loud ones. Originally written for MCP tool metadata
 * (`@flowlathe/plugin-mcp`'s `sanitize.ts`, which now delegates here) and generalized per
 * PLAN-INTEGRATIONS.md §3 rather than duplicated for every plugin that touches untrusted text.
 */

const DEFAULT_MAX_LENGTH = 4000;

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

/** `source` names where this text came from (e.g. "mcp tool description", "searxng result",
 *  "discord message") for the console warning, so a suspicious match is traceable to its origin. */
export function sanitizeUntrustedText(text: string, maxLength = DEFAULT_MAX_LENGTH, source = "untrusted text"): string {
  let cleaned = stripHiddenChars(text);
  if (cleaned.length > maxLength) cleaned = cleaned.slice(0, maxLength);
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      console.warn(`[${source}] suspicious instruction-injection pattern (matched ${pattern}): "${cleaned.slice(0, 120)}"`);
      break;
    }
  }
  return cleaned;
}
