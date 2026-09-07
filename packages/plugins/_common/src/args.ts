/** Thrown for a tool-argument problem (missing/invalid), as opposed to a network/vendor failure
 *  (see PluginHttpError/PluginNetworkError in ./http.js). Kept distinct so a future caller could
 *  choose to treat the two differently; today both just end up as `err.message` in a tool result. */
export class PluginArgError extends Error {}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new PluginArgError(`missing required argument "${key}"`);
  }
  return value;
}

/** Accepts a real array, a JSON-array string, or a comma-separated string — models are
 *  inconsistent about which of these they emit for a "list of ids"/"list of urls" argument.
 *  Moved out of the Spotify plugin (the first place this was written) so SearXNG/Firecrawl/
 *  Discord don't each reinvent it. */
export function asStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.map(String);
  const str = String(value).trim();
  if (str === "") return [];
  if (str.startsWith("[")) {
    try {
      const parsed = JSON.parse(str);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through to comma-splitting
    }
  }
  return str
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function clampLimit(value: unknown, fallback = 20, max = 50): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(n)));
}
