import { httpGetJson } from "@flowlathe/plugin-common";

export interface SearxngResult {
  title: string;
  url: string;
  /** SearXNG's own field name for the snippet — not `description`/`snippet`, per its API. */
  content: string;
  score: number;
  engine: string;
}

interface SearxngSearchResponse {
  results?: SearxngResult[];
}

export interface SearxngSearchOptions {
  categories?: string;
  engines?: string;
  limit?: number;
  timeRange?: string;
}

export interface SearxngClientOptions {
  baseUrl: string;
  /** Overridable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  defaultEngines?: string;
  defaultLanguage?: string;
  defaultSafesearch?: number;
}

/** Every vendor in hermes-agent's web-plugin tree caps search results at 20 server-side; SearXNG
 *  itself has no such cap, so this one is flowlathe's own. */
export const SEARCH_LIMIT_CAP = 20;

/** A thin client over a self-hosted SearXNG instance's JSON search API. No auth, no state. */
export class SearxngClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultEngines: string | undefined;
  private readonly defaultLanguage: string | undefined;
  private readonly defaultSafesearch: number | undefined;

  constructor(opts: SearxngClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.defaultEngines = opts.defaultEngines;
    this.defaultLanguage = opts.defaultLanguage;
    this.defaultSafesearch = opts.defaultSafesearch;
  }

  /** `GET {baseUrl}/search?q=&format=json&pageno=1`. Results come back unsorted with a `score`
   *  field — sort descending by score before capping to `limit` (capped at `SEARCH_LIMIT_CAP`
   *  regardless of what the caller asks for). */
  async search(query: string, opts: SearxngSearchOptions = {}, signal?: AbortSignal): Promise<SearxngResult[]> {
    const response = await httpGetJson<SearxngSearchResponse>("SearXNG search", `${this.baseUrl}/search`, {
      params: {
        q: query,
        format: "json",
        pageno: 1,
        categories: opts.categories,
        engines: opts.engines ?? this.defaultEngines,
        time_range: opts.timeRange,
        language: this.defaultLanguage,
        safesearch: this.defaultSafesearch,
      },
      headers: { Accept: "application/json" },
      reachTarget: this.baseUrl,
      fetchImpl: this.fetchImpl,
      signal,
    });
    const limit = Math.max(1, Math.min(opts.limit ?? SEARCH_LIMIT_CAP, SEARCH_LIMIT_CAP));
    return [...(response.results ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, limit);
  }

  /** Liveness probe for `unavailableReason` (see tools.ts) — hits SearXNG's own `/config`
   *  endpoint, which exists purely to answer "is this instance up," so it's cheap to poll. */
  async isReachable(): Promise<boolean> {
    try {
      await httpGetJson("SearXNG probe", `${this.baseUrl}/config`, {
        reachTarget: this.baseUrl,
        fetchImpl: this.fetchImpl,
        timeoutMs: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }
}
