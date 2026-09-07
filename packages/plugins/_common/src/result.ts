/**
 * One result envelope for a tool's return string, shared across the web-ish plugins
 * (SearXNG/Firecrawl/Discord) so a local model learns one JSON shape instead of three. Mirrors
 * hermes-agent's `plugins/web/_common.py` `search_ok`/`search_fail` convention. Key order is
 * part of the contract — this reaches the model as JSON text, not a typed object, so `ok` always
 * comes first as the cheapest possible signal for a model skimming the start of the string.
 */
export function toolOk(data: unknown): string {
  return JSON.stringify({ ok: true, data });
}

export function toolFail(message: string): string {
  return JSON.stringify({ ok: false, error: message });
}
