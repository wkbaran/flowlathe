/** Ceiling for a parsed Retry-After delay. A hostile or broken server sending an enormous value
 *  (seconds or an HTTP-date far in the future) would otherwise stall a caller for hours; 60s is
 *  long enough to respect a real rate limit without blocking a call indefinitely. */
const MAX_RETRY_AFTER_MS = 60_000;

/** Parses a `Retry-After` header (seconds, or an HTTP-date) into milliseconds, clamped to
 *  [0, MAX_RETRY_AFTER_MS]. */
export function retryAfterMsFromHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return clamp(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return clamp(date - Date.now());
  return undefined;
}

function clamp(ms: number): number {
  return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, ms));
}
