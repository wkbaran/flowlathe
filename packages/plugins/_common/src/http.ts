/** A vendor responded, but with a non-2xx status. Carries the body (truncated) so a caller can
 *  surface e.g. an API's own error message rather than just "HTTP 401". */
export class PluginHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
  }
}

/** The request never got a response at all — DNS failure, connection refused, timeout. Distinct
 *  from PluginHttpError so `guarded`'s classifier can name the host as unreachable rather than
 *  quoting a made-up status code. */
export class PluginNetworkError extends Error {}

export interface HttpGetJsonOptions {
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Named in the unreachable-host error message — e.g. a self-hosted SearXNG instance's own
   *  base URL, so an operator immediately knows which of their two local services is down. */
  reachTarget?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal | undefined;
}

/** GET a URL and parse the response as JSON, with one non-2xx/unreachable/unparseable error
 *  taxonomy shared by every plugin that hits a REST API. `reachTarget` — not the bare hostname —
 *  is what makes the resulting error useful to someone self-hosting the vendor. */
export async function httpGetJson<T>(label: string, url: string, opts: HttpGetJsonOptions = {}): Promise<T> {
  return requestJson<T>(label, url, "GET", opts);
}

export interface HttpRequestJsonOptions extends HttpGetJsonOptions {
  body?: unknown;
}

export async function requestJson<T>(
  label: string,
  url: string,
  method: string,
  opts: HttpRequestJsonOptions = {},
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const target = new URL(url);
  for (const [key, value] of Object.entries(opts.params ?? {})) {
    if (value !== undefined) target.searchParams.set(key, String(value));
  }

  const controller = opts.timeoutMs ? new AbortController() : undefined;
  const timer = controller && opts.timeoutMs ? setTimeout(() => controller.abort(), opts.timeoutMs) : undefined;
  const signal = controller?.signal ?? opts.signal;
  if (controller && opts.signal) {
    opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetchImpl(target.toString(), {
      method,
      headers: {
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    throw new PluginNetworkError(`${label}: could not reach ${opts.reachTarget ?? target.host} (${(err as Error).message})`);
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new PluginHttpError(`${label}: HTTP ${res.status}`, res.status, text.slice(0, 500));
  }
  if (text.trim() === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SyntaxError(`${label}: response was not valid JSON`);
  }
}

/**
 * Runs `fn`, classifying any failure into one readable string — "unreachable host",
 * "HTTP 4xx/5xx with a body", "unparseable JSON", or a generic fallback — so every plugin's
 * errors read the same instead of each inventing its own shape. Mirrors hermes-agent's
 * `run_search`/`run_extract` guarded-execution wrapper.
 */
export async function guarded<T>(
  vendor: string,
  kind: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    return { ok: false, error: classifyError(vendor, kind, err) };
  }
}

/** `PluginNetworkError`/`PluginHttpError` already carry a caller-supplied `label` (from
 *  `httpGetJson`/`requestJson`) describing what failed, so they're returned as-is rather than
 *  re-prefixed with `vendor`/`kind` — a caller composing `guarded(vendor, kind, () =>
 *  httpGetJson(label, ...))` would otherwise get a doubled-up message. The `vendor ${kind}
 *  failed:` prefix is reserved for errors with no such built-in context. */
function classifyError(vendor: string, kind: string, err: unknown): string {
  if (err instanceof PluginHttpError) return err.body ? `${err.message} - ${err.body}` : err.message;
  if (err instanceof PluginNetworkError) return err.message;
  if (err instanceof SyntaxError) return `${vendor} ${kind} failed: ${err.message}`;
  if ((err as { name?: string })?.name === "AbortError") return `${vendor} ${kind} failed: request timed out or was cancelled`;
  return `${vendor} ${kind} failed: ${err instanceof Error ? err.message : String(err)}`;
}
