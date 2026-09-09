import { retryAfterMsFromHeader } from "@flowlathe/providers";
import { gitRefSlot, httpGetJson, repoSlugSlot } from "@flowlathe/plugin-common";

export class GithubError extends Error {}

const DEFAULT_API_BASE_URL = "https://api.github.com";
const MAX_RETRIES = 3;
const DEFAULT_RETRY_MS = 1000;
const API_VERSION = "2022-11-28";
/** GitHub itself caps the files-changed list well below this, but a very large PR can still
 *  exceed it; capped independently so `github_get_pull_request`'s output stays bounded even
 *  against an API that changes its own limit. */
const FILES_MAX = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GithubClientOptions {
  token: string;
  /** Default "https://api.github.com"; overridable for GitHub Enterprise and for tests. */
  apiBaseUrl?: string;
  /** Overridable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface GithubIssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  labels: string[];
  commentCount: number;
  updatedAt: string;
  url: string;
}

export interface GithubCommentSummary {
  author: string;
  body: string;
  createdAt: string;
}

export interface GithubIssueDetail extends GithubIssueSummary {
  body: string;
  comments: GithubCommentSummary[];
}

export interface GithubPullRequestSummary {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  head: string;
  base: string;
  updatedAt: string;
  url: string;
}

export interface GithubPullRequestFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface GithubPullRequestDetail extends GithubPullRequestSummary {
  body: string;
  files: GithubPullRequestFile[];
  filesTruncated: boolean;
  /** Present only when requested via `includeDiff` — the concatenation of every file's own
   *  `patch`, one header per file. Deliberately not truncated or sanitized here: it carries its
   *  own truncation marker and must be scrubbed-then-sliced by the caller (tools.ts), never
   *  passed through `sanitizeUntrustedText(text, maxLength)` — see CLAUDE.md's sanitization
   *  boundary note. */
  diff?: string;
}

export interface GithubCheckSummary {
  name: string;
  status: string;
  conclusion: string | null;
  url: string;
  /** From a modern check run's `output.summary` only — never `output.text`, which can be
   *  arbitrarily long CI log output authored by whoever opened the PR. Absent for a legacy
   *  commit-status entry, which carries no such field. */
  outputSummary?: string;
}

export interface GithubChecksResult {
  state: string;
  checks: GithubCheckSummary[];
}

interface RawGithubUser {
  login: string;
}

interface RawGithubLabel {
  name: string;
}

interface RawGithubIssue {
  number: number;
  title: string;
  state: string;
  user: RawGithubUser | null;
  labels: (RawGithubLabel | string)[];
  comments: number;
  updated_at: string;
  html_url: string;
  body?: string | null;
  /** Present (any value, including `null`) on every pull request returned by the `/issues`
   *  endpoint — a PR is an issue in GitHub's data model. Its mere presence is the discriminator;
   *  its value is never read. */
  pull_request?: unknown;
}

interface RawGithubComment {
  user: RawGithubUser | null;
  body: string | null;
  created_at: string;
}

interface RawGithubPullRequest {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  user: RawGithubUser | null;
  head: { ref: string };
  base: { ref: string };
  updated_at: string;
  html_url: string;
  body?: string | null;
}

interface RawGithubPullRequestFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

interface RawGithubCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  output?: { summary?: string | null } | null;
}

interface RawGithubCombinedStatus {
  state: string;
  statuses: { context: string; state: string; target_url: string | null }[];
}

function labelName(label: RawGithubLabel | string): string {
  return typeof label === "string" ? label : label.name;
}

function issueSummary(raw: RawGithubIssue): GithubIssueSummary {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    author: raw.user?.login ?? "unknown",
    labels: raw.labels.map(labelName),
    commentCount: raw.comments,
    updatedAt: raw.updated_at,
    url: raw.html_url,
  };
}

function pullRequestSummary(raw: RawGithubPullRequest): GithubPullRequestSummary {
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    draft: raw.draft,
    author: raw.user?.login ?? "unknown",
    head: raw.head.ref,
    base: raw.base.ref,
    updatedAt: raw.updated_at,
    url: raw.html_url,
  };
}

/** A check run "fails" for the merged `state` if its conclusion is any of these — mirrors what
 *  GitHub's own branch-protection UI treats as red. */
const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

function overallState(checkRuns: RawGithubCheckRun[], combinedState: string): string {
  if (combinedState === "failure" || combinedState === "error" || checkRuns.some((c) => c.conclusion && FAILING_CONCLUSIONS.has(c.conclusion))) {
    return "failure";
  }
  if (combinedState === "pending" || checkRuns.some((c) => c.status !== "completed")) {
    return "pending";
  }
  return "success";
}

/** Hand-rolled REST client over `fetch`, modeled on `DiscordClient` — static-token auth, an
 *  injected `fetchImpl` for offline tests, and the same bounded-retry shape for 429s. GitHub's
 *  own rate-limit taxonomy is richer than Discord's, though: see `request()`'s doc comment. */
export class GithubClient {
  readonly apiBaseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GithubClientOptions) {
    this.token = opts.token;
    this.apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(hasBody: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "flowlathe",
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
    };
  }

  /** GitHub signals a *primary* rate-limit exhaustion with a 403 and `x-ratelimit-remaining: 0`
   *  (never retried — the reset can be an hour out) and a *secondary* (abuse) limit with a
   *  `retry-after` header on either 403 or 429 (retried, bounded at `MAX_RETRIES`). Any other 403
   *  is an authorization failure (the PAT lacks the scope, or can't see the repo) and must not be
   *  reported as a rate limit — collapsing any two of these three cases produces a misleading
   *  error. */
  private async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; signal?: AbortSignal; repoLabel?: string } = {},
  ): Promise<T> {
    const url = `${this.apiBaseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: this.headers(opts.body !== undefined),
          ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
      } catch (err) {
        throw new GithubError(`could not reach GitHub: ${(err as Error).message}`);
      }

      if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
        const reset = res.headers.get("x-ratelimit-reset");
        const resetAt = reset ? new Date(Number(reset) * 1000).toISOString() : "an unknown time";
        throw new GithubError(`GitHub primary rate limit exceeded; resets at ${resetAt}`);
      }

      if ((res.status === 429 || res.status === 403) && attempt < MAX_RETRIES) {
        const retryMs = retryAfterMsFromHeader(res.headers.get("retry-after"));
        if (retryMs !== undefined) {
          await sleep(retryMs || DEFAULT_RETRY_MS);
          continue;
        }
      }

      if (res.status === 403) {
        const text = await res.text();
        throw new GithubError(
          `GitHub denied access${opts.repoLabel ? ` to "${opts.repoLabel}"` : ""}: HTTP 403 ${text.slice(0, 300)}`,
        );
      }

      const text = await res.text();
      if (!res.ok) {
        throw new GithubError(`GitHub API ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      }
      if (text.trim() === "") return undefined as T;
      return JSON.parse(text) as T;
    }
  }

  /** `/rate_limit` is documented by GitHub as not counting against the rate limit itself, and it
   *  401s on a bad or expired token — a combined reachability *and* auth check in one free call.
   *  Deliberately bypasses `request()`'s retry loop: a liveness probe should report quickly, not
   *  back off and retry. */
  async isReachable(signal?: AbortSignal): Promise<boolean> {
    try {
      await httpGetJson("GitHub rate_limit probe", `${this.apiBaseUrl}/rate_limit`, {
        headers: this.headers(false),
        reachTarget: this.apiBaseUrl,
        fetchImpl: this.fetchImpl,
        timeoutMs: 5000,
        ...(signal ? { signal } : {}),
      });
      return true;
    } catch {
      return false;
    }
  }

  async listIssues(
    repo: string,
    opts: { state?: string; labels?: string[]; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<GithubIssueSummary[]> {
    const { owner, name } = repoSlugSlot(repo, "repo");
    const params = new URLSearchParams({ state: opts.state ?? "open", per_page: String(opts.limit ?? 20) });
    if (opts.labels?.length) params.set("labels", opts.labels.join(","));
    const raw = await this.request<RawGithubIssue[]>("GET", `/repos/${owner}/${name}/issues?${params.toString()}`, {
      repoLabel: repo,
      ...(signal ? { signal } : {}),
    });
    // GitHub's /issues endpoint returns pull requests too — a PR is an issue in its data model,
    // distinguished only by a `pull_request` key on the item. Filter those out or this tool's
    // issue count (and contents) silently includes PRs.
    return raw.filter((issue) => issue.pull_request === undefined).map(issueSummary);
  }

  async getIssue(
    repo: string,
    number: number,
    opts: { commentLimit?: number } = {},
    signal?: AbortSignal,
  ): Promise<GithubIssueDetail> {
    const { owner, name } = repoSlugSlot(repo, "repo");
    const raw = await this.request<RawGithubIssue>("GET", `/repos/${owner}/${name}/issues/${number}`, {
      repoLabel: repo,
      ...(signal ? { signal } : {}),
    });
    const commentLimit = opts.commentLimit ?? 10;
    let comments: GithubCommentSummary[] = [];
    if (commentLimit > 0) {
      const params = new URLSearchParams({ per_page: String(commentLimit), sort: "created", direction: "desc" });
      const rawComments = await this.request<RawGithubComment[]>(
        "GET",
        `/repos/${owner}/${name}/issues/${number}/comments?${params.toString()}`,
        { repoLabel: repo, ...(signal ? { signal } : {}) },
      );
      // Fetched newest-first (so `per_page` keeps the *most recent* N), then reversed back to
      // chronological order for readability.
      comments = rawComments.reverse().map((c) => ({ author: c.user?.login ?? "unknown", body: c.body ?? "", createdAt: c.created_at }));
    }
    return { ...issueSummary(raw), body: raw.body ?? "", comments };
  }

  async listPullRequests(
    repo: string,
    opts: { state?: string; limit?: number } = {},
    signal?: AbortSignal,
  ): Promise<GithubPullRequestSummary[]> {
    const { owner, name } = repoSlugSlot(repo, "repo");
    const params = new URLSearchParams({ state: opts.state ?? "open", per_page: String(opts.limit ?? 20) });
    const raw = await this.request<RawGithubPullRequest[]>("GET", `/repos/${owner}/${name}/pulls?${params.toString()}`, {
      repoLabel: repo,
      ...(signal ? { signal } : {}),
    });
    return raw.map(pullRequestSummary);
  }

  async getPullRequest(
    repo: string,
    number: number,
    opts: { includeDiff?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<GithubPullRequestDetail> {
    const { owner, name } = repoSlugSlot(repo, "repo");
    const raw = await this.request<RawGithubPullRequest>("GET", `/repos/${owner}/${name}/pulls/${number}`, {
      repoLabel: repo,
      ...(signal ? { signal } : {}),
    });
    // The `/files` endpoint's own `patch` field is used rather than the `.diff` media type: it
    // needs no separate Accept header, it's already per-file, and GitHub itself omits `patch` for
    // files it considers too large — free bounding before this file's own cap even applies.
    const rawFiles = await this.request<RawGithubPullRequestFile[]>(
      "GET",
      `/repos/${owner}/${name}/pulls/${number}/files?per_page=${FILES_MAX}`,
      { repoLabel: repo, ...(signal ? { signal } : {}) },
    );
    const filesTruncated = rawFiles.length > FILES_MAX;
    const boundedFiles = rawFiles.slice(0, FILES_MAX);
    const files = boundedFiles.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions }));
    const diff = opts.includeDiff
      ? boundedFiles
          .filter((f) => f.patch !== undefined)
          .map((f) => `--- ${f.filename} ---\n${f.patch}`)
          .join("\n\n")
      : undefined;
    return { ...pullRequestSummary(raw), body: raw.body ?? "", files, filesTruncated, ...(diff !== undefined ? { diff } : {}) };
  }

  async getChecks(repo: string, ref: string, signal?: AbortSignal): Promise<GithubChecksResult> {
    const { owner, name } = repoSlugSlot(repo, "repo");
    const validRef = gitRefSlot(ref, "ref");
    const [checkRuns, combined] = await Promise.all([
      this.request<{ check_runs: RawGithubCheckRun[] }>("GET", `/repos/${owner}/${name}/commits/${validRef}/check-runs`, {
        repoLabel: repo,
        ...(signal ? { signal } : {}),
      }),
      this.request<RawGithubCombinedStatus>("GET", `/repos/${owner}/${name}/commits/${validRef}/status`, {
        repoLabel: repo,
        ...(signal ? { signal } : {}),
      }),
    ]);
    // Both modern check runs and the legacy combined commit status are queried and merged —
    // different CI providers still populate different ones, and a flow asking "did this pass"
    // that silently misses half the signal is worse than no tool.
    const checks: GithubCheckSummary[] = [
      ...checkRuns.check_runs.map((c) => ({
        name: c.name,
        status: c.status,
        conclusion: c.conclusion,
        url: c.html_url ?? "",
        ...(c.output?.summary ? { outputSummary: c.output.summary } : {}),
      })),
      ...combined.statuses.map((s) => ({ name: s.context, status: s.state, conclusion: s.state, url: s.target_url ?? "" })),
    ];
    return { state: overallState(checkRuns.check_runs, combined.state), checks };
  }

  async createIssue(
    repo: string,
    opts: { title: string; body?: string; labels?: string[] },
    signal?: AbortSignal,
  ): Promise<{ number: number; url: string }> {
    const { owner, name } = repoSlugSlot(repo, "repo");
    const payload: Record<string, unknown> = { title: opts.title };
    if (opts.body !== undefined) payload["body"] = opts.body;
    if (opts.labels?.length) payload["labels"] = opts.labels;
    const raw = await this.request<{ number: number; html_url: string }>("POST", `/repos/${owner}/${name}/issues`, {
      body: payload,
      repoLabel: repo,
      ...(signal ? { signal } : {}),
    });
    return { number: raw.number, url: raw.html_url };
  }

  /** Serves both issues and pull requests through the issue-comments endpoint — the same
   *  data-model fact that requires `listIssues` to filter `pull_request`-carrying items: a PR
   *  *is* an issue, so its comments live at the same path. */
  async createComment(repo: string, number: number, body: string, signal?: AbortSignal): Promise<{ id: number; url: string }> {
    const { owner, name } = repoSlugSlot(repo, "repo");
    const raw = await this.request<{ id: number; html_url: string }>("POST", `/repos/${owner}/${name}/issues/${number}/comments`, {
      body: { body },
      repoLabel: repo,
      ...(signal ? { signal } : {}),
    });
    return { id: raw.id, url: raw.html_url };
  }

  async createPullRequest(
    repo: string,
    opts: { title: string; head: string; base: string; body?: string; draft?: boolean },
    signal?: AbortSignal,
  ): Promise<{ number: number; url: string }> {
    const { owner, name } = repoSlugSlot(repo, "repo");
    const head = gitRefSlot(opts.head, "head");
    const base = gitRefSlot(opts.base, "base");
    const payload: Record<string, unknown> = { title: opts.title, head, base, draft: opts.draft ?? true };
    if (opts.body !== undefined) payload["body"] = opts.body;
    const raw = await this.request<{ number: number; html_url: string }>("POST", `/repos/${owner}/${name}/pulls`, {
      body: payload,
      repoLabel: repo,
      ...(signal ? { signal } : {}),
    });
    return { number: raw.number, url: raw.html_url };
  }
}
