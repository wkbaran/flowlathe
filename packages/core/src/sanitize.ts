/**
 * Untrusted text landing in a model's context — an MCP tool description, a SearXNG search
 * result snippet, a scraped web page, a Discord message someone else sent — can't be trusted not
 * to contain a prompt-injection attempt or hidden characters. This module can't stop a
 * sufficiently novel injection, but it strips the cheap tricks (hidden/control characters,
 * unbounded length) and flags the loud ones. Originally written for MCP tool metadata
 * (`@flowlathe/plugin-mcp`'s `sanitize.ts`, which now delegates here), generalized per
 * PLAN-INTEGRATIONS.md §3, and moved here from `@flowlathe/plugin-common` per
 * PLAN-SANITIZATION-BOUNDARY.md §2 so the runtime tool-registry choke point can use it too
 * (`@flowlathe/plugin-common` re-exports it unchanged, so no plugin call site needed to move).
 *
 * This is layer 1 of a deliberate two-layer arrangement (see CLAUDE.md and
 * `packages/runtime/src/tool-registry.ts`): per-field sanitization here, at the source, plus a
 * single generous whole-result cap at the tool-invocation choke point. Neither layer may be
 * deleted — layer 1 is forgettable (a new plugin author can skip it), layer 2 can't be granular
 * (it can't know a Discord username should be capped at 100 chars and a scraped page at 20,000).
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

/** Characters used to hide text from a human reviewer, or to smuggle instructions into a model's
 *  context invisibly. Built from numeric code points rather than a regex literal, so this file's
 *  source never has to embed the actual invisible characters it's trying to strip.
 *   - ZWSP/ZWNJ/ZWJ (U+200B-200D), line/paragraph separators (U+2028-2029), bidi overrides
 *     (U+202A-202E), word joiner (U+2060), BOM/zero-width-no-break-space (U+FEFF).
 *   - bidi **isolates** (U+2066-2069, LRI/RLI/FSI/PDI) — U+202A-202E covers only the older
 *     embeddings/overrides; the isolates are what the Trojan Source technique actually uses.
 *   - Unicode **tag characters** (U+E0000-E007F) — the current standard invisible-ASCII-smuggling
 *     vector against LLMs specifically. The most significant of these additions.
 *   - soft hyphen (U+00AD) and the Mongolian vowel separator (U+180E).
 *  The U+00AD entry has a known false-positive cost: legitimately hyphenated text loses its soft
 *  hyphens. That's the right trade for text whose only destination is a model's context. */
const HIDDEN_CHAR_RANGES: readonly [number, number][] = [
  [0x200b, 0x200d],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2060],
  [0xfeff, 0xfeff],
  [0x2066, 0x2069],
  [0xe0000, 0xe007f],
  [0x00ad, 0x00ad],
  [0x180e, 0x180e],
];
const HIDDEN_CHARS = new RegExp(
  `[${HIDDEN_CHAR_RANGES.map(([start, end]) => `\\u{${start.toString(16)}}-\\u{${end.toString(16)}}`).join("")}]`,
  "gu",
);

function stripHiddenChars(text: string): string {
  return text.replace(CONTROL_CHARS, "").replace(HIDDEN_CHARS, "");
}

function warnIfInjection(cleaned: string, source: string): void {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(cleaned)) {
      console.warn(`[${source}] suspicious instruction-injection pattern (matched ${pattern}): "${cleaned.slice(0, 120)}"`);
      break;
    }
  }
}

/**
 * Strip hidden/control characters and flag loud injection phrasing. No length bound — for
 * callers that own their own truncation (and its marker, e.g. Firecrawl's
 * `[truncated N of M chars]`, which a bound-then-truncate ordering would otherwise cut off).
 * The injection scan runs on the FULL scrubbed text, so a match sitting past where a caller will
 * later truncate is still flagged.
 */
export function scrubUntrustedText(text: string, source = "untrusted text"): string {
  const cleaned = stripHiddenChars(text);
  warnIfInjection(cleaned, source);
  return cleaned;
}

/**
 * `scrubUntrustedText`, then bound to `maxLength`. `source` names where this text came from
 * (e.g. "mcp tool description", "searxng result", "discord message") for the console warning, so
 * a suspicious match is traceable to its origin.
 */
export function sanitizeUntrustedText(text: string, maxLength = DEFAULT_MAX_LENGTH, source = "untrusted text"): string {
  const cleaned = scrubUntrustedText(text, source);
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}
