import { checkUrlSafety, sanitizeUntrustedText, scrubUntrustedText } from "@flowlathe/core";
import { httpGetJson, requestJson } from "@flowlathe/plugin-common";

export class FirecrawlError extends Error {}

export interface ScrapedPage {
  url: string;
  title?: string | undefined;
  content: string;
  error?: undefined;
}

export interface ScrapeFailure {
  url: string;
  error: string;
  title?: undefined;
  content?: undefined;
}

export type ScrapeOutcome = ScrapedPage | ScrapeFailure;

export interface FirecrawlClientOptions {
  apiKey: string;
  /** Self-hosted Firecrawl is first-class — defaults to Firecrawl's own cloud API. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Applied to every scraped/crawled page's content, unless overridden per call. */
  maxChars?: number;
  /** Bounded wall-clock budget for the async crawl-submit-then-poll flow. */
  crawlTimeoutMs?: number;
  crawlPollIntervalMs?: number;
  allowPrivateUrls?: boolean;
}

const DEFAULT_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_MAX_CHARS = 20_000;
const DEFAULT_CRAWL_TIMEOUT_MS = 120_000;
const DEFAULT_CRAWL_POLL_INTERVAL_MS = 1000;
/** Hermes-agent's figure for a single scrape — its own message names a fallback, which this
 *  mirrors (adjusted since flowlathe has no browser-navigate tool to suggest instead). */
const PER_URL_TIMEOUT_MS = 60_000;

interface FirecrawlScrapeResponseData {
  markdown?: string;
  html?: string;
  metadata?: { title?: string; sourceURL?: string };
}

interface FirecrawlScrapeResponse {
  data?: FirecrawlScrapeResponseData;
}

interface FirecrawlCrawlSubmitResponse {
  id: string;
}

interface FirecrawlCrawlStatusResponse {
  status: "scraping" | "completed" | "failed" | "cancelled";
  data?: FirecrawlScrapeResponseData[];
}

interface FirecrawlMapResponse {
  links?: string[];
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${maxChars} of ${text.length} chars]`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** REST-only client (no SDK — see PLAN-INTEGRATIONS.md §4, "typing one REST shape is strictly
 *  less work" than a lazy-loaded SDK proxy plus response normalization). */
export class FirecrawlClient {
  private readonly apiKey: string;
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxChars: number;
  private readonly crawlTimeoutMs: number;
  private readonly crawlPollIntervalMs: number;
  private readonly allowPrivateUrls: boolean;

  constructor(opts: FirecrawlClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.crawlTimeoutMs = opts.crawlTimeoutMs ?? DEFAULT_CRAWL_TIMEOUT_MS;
    this.crawlPollIntervalMs = opts.crawlPollIntervalMs ?? DEFAULT_CRAWL_POLL_INTERVAL_MS;
    this.allowPrivateUrls = opts.allowPrivateUrls ?? false;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  /** Throws (caught by every public method's per-URL try/catch) rather than returning a verdict
   *  — every call site here treats "unsafe URL" exactly like any other per-URL failure. */
  private assertUrlSafe(url: string): void {
    const verdict = checkUrlSafety(url, { allowPrivate: this.allowPrivateUrls });
    if (!verdict.ok) throw new FirecrawlError(verdict.reason ?? "Blocked: unsafe URL");
  }

  private toOutcome(url: string, data: FirecrawlScrapeResponseData | undefined, maxChars: number): ScrapeOutcome {
    // Re-validate the POST-REDIRECT final URL (Firecrawl reports it as metadata.sourceURL) —
    // a public URL that 302s to 127.0.0.1 would otherwise defeat every check above.
    const finalUrl = data?.metadata?.sourceURL ?? url;
    this.assertUrlSafe(finalUrl);
    const raw = data?.markdown ?? data?.html ?? "";
    // scrub, then truncate — in that order: truncate appends the `[truncated N of M chars]`
    // marker, and a sanitizeUntrustedText(x, maxChars) call would silently slice it back off.
    const content = truncate(scrubUntrustedText(raw, "firecrawl page"), maxChars);
    const title = data?.metadata?.title !== undefined ? sanitizeUntrustedText(data.metadata.title, 500, "firecrawl page") : undefined;
    return { url: finalUrl, title, content };
  }

  /** Never throws — a dead link in a batch produces `{url, error}` in its slot, per
   *  PLAN-INTEGRATIONS.md §4's "per-URL results, never a whole-batch failure." */
  async scrapeOne(
    url: string,
    opts: { formats?: ("markdown" | "html")[]; onlyMainContent?: boolean; maxChars?: number } = {},
    signal?: AbortSignal,
  ): Promise<ScrapeOutcome> {
    try {
      this.assertUrlSafe(url);
      const response = await requestJson<FirecrawlScrapeResponse>("Firecrawl scrape", `${this.baseUrl}/v2/scrape`, "POST", {
        headers: this.authHeaders(),
        body: { url, formats: opts.formats ?? ["markdown"], onlyMainContent: opts.onlyMainContent ?? true },
        timeoutMs: PER_URL_TIMEOUT_MS,
        fetchImpl: this.fetchImpl,
        reachTarget: this.baseUrl,
        ...(signal ? { signal } : {}),
      });
      return this.toOutcome(url, response.data, opts.maxChars ?? this.maxChars);
    } catch (err) {
      return { url, error: describeError(err) };
    }
  }

  /** Submits a crawl job and polls it to completion within `crawlTimeoutMs` — Firecrawl's crawl
   *  endpoint is asynchronous by nature (a "scrape the whole site" job can take minutes), and a
   *  tool handler that never returns is indistinguishable from a hung provider call in the UI. */
  async crawl(
    url: string,
    opts: { limit?: number; maxDepth?: number; includePaths?: string[]; maxChars?: number } = {},
    signal?: AbortSignal,
  ): Promise<ScrapeOutcome[]> {
    try {
      this.assertUrlSafe(url);
      const submitted = await requestJson<FirecrawlCrawlSubmitResponse>(
        "Firecrawl crawl submit",
        `${this.baseUrl}/v2/crawl`,
        "POST",
        {
          headers: this.authHeaders(),
          body: {
            url,
            limit: opts.limit ?? 10,
            ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
            ...(opts.includePaths ? { includePaths: opts.includePaths } : {}),
          },
          fetchImpl: this.fetchImpl,
          reachTarget: this.baseUrl,
          ...(signal ? { signal } : {}),
        },
      );

      const deadline = Date.now() + this.crawlTimeoutMs;
      const maxChars = opts.maxChars ?? this.maxChars;
      for (;;) {
        if (signal?.aborted) return [{ url, error: "Firecrawl crawl cancelled" }];
        const status = await httpGetJson<FirecrawlCrawlStatusResponse>(
          "Firecrawl crawl poll",
          `${this.baseUrl}/v2/crawl/${submitted.id}`,
          { headers: this.authHeaders(), fetchImpl: this.fetchImpl, reachTarget: this.baseUrl, ...(signal ? { signal } : {}) },
        );
        if (status.status === "completed") {
          return (status.data ?? []).map((page) => {
            try {
              return this.toOutcome(url, page, maxChars);
            } catch (err) {
              return { url: page.metadata?.sourceURL ?? url, error: describeError(err) };
            }
          });
        }
        if (status.status === "failed" || status.status === "cancelled") {
          return [{ url, error: `Firecrawl crawl ${status.status}` }];
        }
        if (Date.now() >= deadline) {
          return [
            {
              url,
              error: `Firecrawl crawl timed out after ${this.crawlTimeoutMs}ms — page may be too large or unresponsive`,
            },
          ];
        }
        await sleep(this.crawlPollIntervalMs);
      }
    } catch (err) {
      return [{ url, error: describeError(err) }];
    }
  }

  /** Cheap URL discovery ("which pages exist") — no content fetched. */
  async map(url: string, opts: { search?: string } = {}, signal?: AbortSignal): Promise<{ urls: string[] } | { error: string }> {
    try {
      this.assertUrlSafe(url);
      const response = await requestJson<FirecrawlMapResponse>("Firecrawl map", `${this.baseUrl}/v2/map`, "POST", {
        headers: this.authHeaders(),
        body: { url, ...(opts.search ? { search: opts.search } : {}) },
        fetchImpl: this.fetchImpl,
        reachTarget: this.baseUrl,
        ...(signal ? { signal } : {}),
      });
      return { urls: response.links ?? [] };
    } catch (err) {
      return { error: describeError(err) };
    }
  }

  /** Liveness/auth probe for `unavailableReason` — see `tools.ts`. Firecrawl has no dedicated
   *  health endpoint, so a cheap `map` of its own docs domain doubles as an auth check (a bad
   *  API key 401s). */
  async isAuthorized(): Promise<boolean> {
    try {
      await requestJson("Firecrawl auth probe", `${this.baseUrl}/v2/map`, "POST", {
        headers: this.authHeaders(),
        body: { url: "https://firecrawl.dev", limit: 1 },
        fetchImpl: this.fetchImpl,
        reachTarget: this.baseUrl,
        timeoutMs: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
