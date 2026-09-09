import type { ToolInvokeMeta, ToolRegistration, ToolSpec } from "@flowlathe/core";
import {
  asStringArray,
  CachedLivenessProbe,
  gitRefSlot,
  guarded,
  intSlot,
  repoSlugSlot,
  requireString,
  sanitizeUntrustedText,
  scrubUntrustedText,
  SlotError,
  textSlot,
  toolFail,
  toolOk,
} from "@flowlathe/plugin-common";
import {
  GithubClient,
  type GithubChecksResult,
  type GithubCheckSummary,
  type GithubCommentSummary,
  type GithubIssueDetail,
  type GithubIssueSummary,
  type GithubPullRequestDetail,
  type GithubPullRequestFile,
  type GithubPullRequestSummary,
} from "./client.js";

export interface GithubToolsetOptions {
  /** `GITHUB_ALLOWED_REPOS`, lowercased. Empty means no repository is allowed — the same secure
   *  default as `DISCORD_ALLOWED_CHANNELS`/`MCP_ALLOWED_COMMANDS`. Every tool checks its `repo`
   *  argument against this before doing anything. */
  allowedRepos: ReadonlySet<string>;
  /** `ro` registers only the five read tools; `rw` also registers the three write tools. */
  mode: "ro" | "rw";
}

function repoAllowlistError(slug: string, allowed: ReadonlySet<string>): string | undefined {
  if (allowed.has(slug.toLowerCase())) return undefined;
  return `repository "${slug}" is not in GITHUB_ALLOWED_REPOS (currently: ${[...allowed].join(", ") || "(none)"})`;
}

const DIFF_MAX_CHARS = 12_000;

function summarizeIssue(issue: GithubIssueSummary): Record<string, unknown> {
  return {
    number: issue.number,
    title: sanitizeUntrustedText(issue.title, 300, "github issue title"),
    state: issue.state,
    author: sanitizeUntrustedText(issue.author, 100, "github login"),
    labels: issue.labels.map((l) => sanitizeUntrustedText(l, 300, "github label")),
    commentCount: issue.commentCount,
    updatedAt: issue.updatedAt,
    url: issue.url,
  };
}

function summarizeComment(comment: GithubCommentSummary): Record<string, unknown> {
  return {
    author: sanitizeUntrustedText(comment.author, 100, "github login"),
    body: sanitizeUntrustedText(comment.body, 2000, "github comment body"),
    createdAt: comment.createdAt,
  };
}

function summarizeIssueDetail(detail: GithubIssueDetail): Record<string, unknown> {
  return {
    ...summarizeIssue(detail),
    body: sanitizeUntrustedText(detail.body, 4000, "github issue body"),
    comments: detail.comments.map(summarizeComment),
  };
}

function summarizePullRequest(pr: GithubPullRequestSummary): Record<string, unknown> {
  return {
    number: pr.number,
    title: sanitizeUntrustedText(pr.title, 300, "github pull request title"),
    state: pr.state,
    draft: pr.draft,
    author: sanitizeUntrustedText(pr.author, 100, "github login"),
    // head/base are branch names, sanitized like any other third-party string — a branch name
    // is attacker-authored on a fork PR.
    head: sanitizeUntrustedText(pr.head, 300, "github branch name"),
    base: sanitizeUntrustedText(pr.base, 300, "github branch name"),
    updatedAt: pr.updatedAt,
    url: pr.url,
  };
}

function summarizePullRequestFile(file: GithubPullRequestFile): Record<string, unknown> {
  return { path: file.path, status: file.status, additions: file.additions, deletions: file.deletions };
}

function summarizePullRequestDetail(detail: GithubPullRequestDetail): Record<string, unknown> {
  const summary: Record<string, unknown> = {
    ...summarizePullRequest(detail),
    body: sanitizeUntrustedText(detail.body, 4000, "github pull request body"),
    files: detail.files.map(summarizePullRequestFile),
    filesTruncated: detail.filesTruncated,
  };
  if (detail.diff !== undefined) {
    // The diff is the one field that owns its own truncation marker, so it's scrubbed then
    // sliced by hand here — passing a maxLength to sanitizeUntrustedText would cut the marker
    // back off.
    const scrubbed = scrubUntrustedText(detail.diff, "github pull request diff");
    summary["diff"] =
      scrubbed.length > DIFF_MAX_CHARS ? `${scrubbed.slice(0, DIFF_MAX_CHARS)}\n[truncated ${DIFF_MAX_CHARS} of ${scrubbed.length} chars]` : scrubbed;
  }
  return summary;
}

function summarizeCheck(check: GithubCheckSummary): Record<string, unknown> {
  return {
    name: sanitizeUntrustedText(check.name, 200, "github check name"),
    status: check.status,
    conclusion: check.conclusion,
    url: check.url,
    ...(check.outputSummary !== undefined
      ? { outputSummary: sanitizeUntrustedText(check.outputSummary, 1000, "github check output") }
      : {}),
  };
}

function summarizeChecks(result: GithubChecksResult): Record<string, unknown> {
  return { state: result.state, checks: result.checks.map(summarizeCheck) };
}

export const GITHUB_LIST_ISSUES_TOOL: ToolSpec = {
  name: "github_list_issues",
  description: "List issues in a GitHub repository (pull requests are excluded).",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: '"owner/name"' },
      state: { type: "string", description: '"open" (default) | "closed" | "all"' },
      labels: { type: "string", description: "comma-separated or JSON array of label names to filter by" },
      limit: { type: "number", description: "max results, 1-50 (default 20)" },
    },
    required: ["repo"],
  },
};

export const GITHUB_GET_ISSUE_TOOL: ToolSpec = {
  name: "github_get_issue",
  description: "Get one issue's details plus its most recent comments.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: '"owner/name"' },
      number: { type: "number", description: "issue number" },
      commentLimit: { type: "number", description: "max comments to include, 0-30 (default 10)" },
    },
    required: ["repo", "number"],
  },
};

export const GITHUB_LIST_PULL_REQUESTS_TOOL: ToolSpec = {
  name: "github_list_pull_requests",
  description: "List pull requests in a GitHub repository.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: '"owner/name"' },
      state: { type: "string", description: '"open" (default) | "closed" | "all"' },
      limit: { type: "number", description: "max results, 1-50 (default 20)" },
    },
    required: ["repo"],
  },
};

export const GITHUB_GET_PULL_REQUEST_TOOL: ToolSpec = {
  name: "github_get_pull_request",
  description: "Get one pull request's details plus its changed-file list, optionally including the diff.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: '"owner/name"' },
      number: { type: "number", description: "pull request number" },
      includeDiff: { type: "boolean", description: "also return each changed file's diff, concatenated and capped (default false)" },
    },
    required: ["repo", "number"],
  },
};

export const GITHUB_GET_CHECKS_TOOL: ToolSpec = {
  name: "github_get_checks",
  description: "Get CI check runs and combined commit status for a branch, tag, or commit sha.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: '"owner/name"' },
      ref: { type: "string", description: "branch, tag, or commit sha" },
    },
    required: ["repo", "ref"],
  },
};

export const GITHUB_CREATE_ISSUE_TOOL: ToolSpec = {
  name: "github_create_issue",
  description: "Open a new issue in a GitHub repository.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: '"owner/name"' },
      title: { type: "string", description: "issue title" },
      body: { type: "string", description: "issue body (markdown)" },
      labels: { type: "string", description: "comma-separated or JSON array of label names to apply" },
    },
    required: ["repo", "title"],
  },
};

export const GITHUB_COMMENT_TOOL: ToolSpec = {
  name: "github_comment",
  description: "Comment on an issue or pull request (GitHub serves both through the same endpoint).",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: '"owner/name"' },
      number: { type: "number", description: "issue or pull request number" },
      body: { type: "string", description: "comment body (markdown)" },
    },
    required: ["repo", "number", "body"],
  },
};

export const GITHUB_CREATE_PULL_REQUEST_TOOL: ToolSpec = {
  name: "github_create_pull_request",
  description: "Open a new pull request. Defaults to draft: true, unlike GitHub's own API default.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: '"owner/name"' },
      title: { type: "string", description: "pull request title" },
      head: { type: "string", description: "branch to merge from" },
      base: { type: "string", description: "branch to merge into" },
      body: { type: "string", description: "pull request body (markdown)" },
      draft: { type: "boolean", description: "default true — a draft PR requests no reviews and notifies no CODEOWNERS" },
    },
    required: ["repo", "title", "head", "base"],
  },
};

/** Shared shape for all five read tools: parse+validate args (throwing `SlotError`/
 *  `PluginArgError` on a bad value), resolve the repo slug and check it against the allowlist,
 *  then call the client with `meta.signal` forwarded, and envelope the result. `repoSlugSlot`
 *  runs inside the same try/catch as argument parsing — an invalid repo (e.g. containing "..")
 *  must become a `toolFail`, not an uncaught throw out of the handler. */
function readTool<T>(
  op: string,
  opts: GithubToolsetOptions,
  parseArgs: (args: Record<string, unknown>) => { repo: string; call: (signal: AbortSignal | undefined) => Promise<T> },
  summarize: (data: T) => unknown,
): ToolRegistration["handler"] {
  return async (args: Record<string, unknown>, meta: ToolInvokeMeta) => {
    let call: (signal: AbortSignal | undefined) => Promise<T>;
    let slug: string;
    try {
      const parsed = parseArgs(args);
      call = parsed.call;
      const { owner, name } = repoSlugSlot(parsed.repo, "repo");
      slug = `${owner}/${name}`;
    } catch (err) {
      return toolFail((err as Error).message);
    }
    const allowlistError = repoAllowlistError(slug, opts.allowedRepos);
    if (allowlistError) return toolFail(allowlistError);
    const result = await guarded("github", op, () => call(meta.signal));
    return result.ok ? toolOk(summarize(result.data)) : toolFail(result.error);
  };
}

function listIssuesTool(client: GithubClient, opts: GithubToolsetOptions): ToolRegistration["handler"] {
  return readTool(
    "list_issues",
    opts,
    (args) => {
      const repo = requireString(args, "repo");
      const state = typeof args["state"] === "string" ? args["state"] : "open";
      if (!["open", "closed", "all"].includes(state)) throw new SlotError(`invalid state: ${JSON.stringify(state)}`);
      const labels = asStringArray(args["labels"]).map((l) => textSlot(l, "label", 100));
      const limit = args["limit"] !== undefined ? intSlot(args["limit"], "limit", 1, 50) : 20;
      return { repo, call: (signal) => client.listIssues(repo, { state, labels, limit }, signal) };
    },
    (issues) => issues.map(summarizeIssue),
  );
}

function getIssueTool(client: GithubClient, opts: GithubToolsetOptions): ToolRegistration["handler"] {
  return readTool(
    "get_issue",
    opts,
    (args) => {
      const repo = requireString(args, "repo");
      const number = intSlot(args["number"], "number", 1, 2_000_000);
      const commentLimit = args["commentLimit"] !== undefined ? intSlot(args["commentLimit"], "commentLimit", 0, 30) : 10;
      return { repo, call: (signal) => client.getIssue(repo, number, { commentLimit }, signal) };
    },
    summarizeIssueDetail,
  );
}

function listPullRequestsTool(client: GithubClient, opts: GithubToolsetOptions): ToolRegistration["handler"] {
  return readTool(
    "list_pull_requests",
    opts,
    (args) => {
      const repo = requireString(args, "repo");
      const state = typeof args["state"] === "string" ? args["state"] : "open";
      if (!["open", "closed", "all"].includes(state)) throw new SlotError(`invalid state: ${JSON.stringify(state)}`);
      const limit = args["limit"] !== undefined ? intSlot(args["limit"], "limit", 1, 50) : 20;
      return { repo, call: (signal) => client.listPullRequests(repo, { state, limit }, signal) };
    },
    (prs) => prs.map(summarizePullRequest),
  );
}

function getPullRequestTool(client: GithubClient, opts: GithubToolsetOptions): ToolRegistration["handler"] {
  return readTool(
    "get_pull_request",
    opts,
    (args) => {
      const repo = requireString(args, "repo");
      const number = intSlot(args["number"], "number", 1, 2_000_000);
      const includeDiff = args["includeDiff"] === true;
      return { repo, call: (signal) => client.getPullRequest(repo, number, { includeDiff }, signal) };
    },
    summarizePullRequestDetail,
  );
}

function getChecksTool(client: GithubClient, opts: GithubToolsetOptions): ToolRegistration["handler"] {
  return readTool(
    "get_checks",
    opts,
    (args) => {
      const repo = requireString(args, "repo");
      const ref = gitRefSlot(requireString(args, "ref"), "ref");
      return { repo, call: (signal) => client.getChecks(repo, ref, signal) };
    },
    summarizeChecks,
  );
}

/** Shared shape for the three write tools — parse+validate args and `repoSlugSlot` inside one
 *  try/catch, check the allowlist, then call with `meta.signal` forwarded. Unlike `readTool`,
 *  each write tool's own return shape is passed straight to `toolOk` — `GithubClient`'s write
 *  methods already return the minimal `{number, url}`/`{id, url}` shape a model needs, with
 *  nothing third-party-authored to sanitize (the model supplied every string itself). */
function writeTool(
  op: string,
  opts: GithubToolsetOptions,
  parseArgs: (args: Record<string, unknown>) => { repo: string; call: (signal: AbortSignal | undefined) => Promise<unknown> },
): ToolRegistration["handler"] {
  return async (args: Record<string, unknown>, meta: ToolInvokeMeta) => {
    let call: (signal: AbortSignal | undefined) => Promise<unknown>;
    let slug: string;
    try {
      const parsed = parseArgs(args);
      call = parsed.call;
      const { owner, name } = repoSlugSlot(parsed.repo, "repo");
      slug = `${owner}/${name}`;
    } catch (err) {
      return toolFail((err as Error).message);
    }
    const allowlistError = repoAllowlistError(slug, opts.allowedRepos);
    if (allowlistError) return toolFail(allowlistError);
    const result = await guarded("github", op, () => call(meta.signal));
    return result.ok ? toolOk(result.data) : toolFail(result.error);
  };
}

function createIssueTool(client: GithubClient, opts: GithubToolsetOptions): ToolRegistration["handler"] {
  return writeTool("create_issue", opts, (args) => {
    const repo = requireString(args, "repo");
    const title = textSlot(requireString(args, "title"), "title", 300);
    const body = args["body"] !== undefined ? textSlot(args["body"], "body", 60_000) : undefined;
    const labels = asStringArray(args["labels"]).map((l) => textSlot(l, "label", 100));
    return {
      repo,
      call: (signal) => client.createIssue(repo, { title, ...(body !== undefined ? { body } : {}), ...(labels.length ? { labels } : {}) }, signal),
    };
  });
}

function commentTool(client: GithubClient, opts: GithubToolsetOptions): ToolRegistration["handler"] {
  return writeTool("comment", opts, (args) => {
    const repo = requireString(args, "repo");
    const number = intSlot(args["number"], "number", 1, 2_000_000);
    const body = textSlot(requireString(args, "body"), "body", 60_000);
    return { repo, call: (signal) => client.createComment(repo, number, body, signal) };
  });
}

function createPullRequestTool(client: GithubClient, opts: GithubToolsetOptions): ToolRegistration["handler"] {
  return writeTool("create_pull_request", opts, (args) => {
    const repo = requireString(args, "repo");
    const title = textSlot(requireString(args, "title"), "title", 300);
    const head = gitRefSlot(requireString(args, "head"), "head");
    const base = gitRefSlot(requireString(args, "base"), "base");
    const body = args["body"] !== undefined ? textSlot(args["body"], "body", 60_000) : undefined;
    const draft = typeof args["draft"] === "boolean" ? args["draft"] : undefined;
    return {
      repo,
      call: (signal) =>
        client.createPullRequest(repo, { title, head, base, ...(body !== undefined ? { body } : {}), ...(draft !== undefined ? { draft } : {}) }, signal),
    };
  });
}

/** Five read tools always; three write tools only under `GITHUB_MODE=rw` — a registered-but-
 *  always-refusing write tool would still reach the model in `tools` and invite calls that
 *  always fail, so this is structural (a different array length), not a per-call check. One
 *  shared `unavailableReason` closure across every registration: an empty allowlist is checked
 *  first (cheap, synchronous), then a `CachedLivenessProbe` over `GET /rate_limit` — never a
 *  direct call, since `unavailableReason` runs synchronously on `/run`, `/step-start`, and every
 *  `GraphEngine` construction. */
export function createGithubToolset(client: GithubClient, opts: GithubToolsetOptions): ToolRegistration[] {
  const liveness = new CachedLivenessProbe(() => client.isReachable());
  const unavailableReason = (): string | undefined => {
    if (opts.allowedRepos.size === 0) return "GitHub has no allowed repositories configured (set GITHUB_ALLOWED_REPOS)";
    return liveness.isReachable() ? undefined : `GitHub API at ${client.apiBaseUrl} is not reachable or the token is invalid`;
  };
  // Config is env-only, exactly like SearXNG/Firecrawl — an operator who set GITHUB_TOKEN on the
  // machine running an exported compiled script opted in there too (PLAN-GITHUB.md L7).
  const standalone = {
    module: "@flowlathe/plugin-github",
    factory: "githubToolsetFromEnv",
    env: ["GITHUB_TOKEN", "GITHUB_ALLOWED_REPOS", "GITHUB_MODE", "GITHUB_API_BASE_URL"],
  };

  const readTools: ToolRegistration[] = [
    { toolset: "github", spec: GITHUB_LIST_ISSUES_TOOL, handler: listIssuesTool(client, opts), unavailableReason, standalone },
    { toolset: "github", spec: GITHUB_GET_ISSUE_TOOL, handler: getIssueTool(client, opts), unavailableReason, standalone },
    { toolset: "github", spec: GITHUB_LIST_PULL_REQUESTS_TOOL, handler: listPullRequestsTool(client, opts), unavailableReason, standalone },
    { toolset: "github", spec: GITHUB_GET_PULL_REQUEST_TOOL, handler: getPullRequestTool(client, opts), unavailableReason, standalone },
    { toolset: "github", spec: GITHUB_GET_CHECKS_TOOL, handler: getChecksTool(client, opts), unavailableReason, standalone },
  ];
  if (opts.mode !== "rw") return readTools;

  return [
    ...readTools,
    { toolset: "github", spec: GITHUB_CREATE_ISSUE_TOOL, handler: createIssueTool(client, opts), unavailableReason, standalone },
    { toolset: "github", spec: GITHUB_COMMENT_TOOL, handler: commentTool(client, opts), unavailableReason, standalone },
    { toolset: "github", spec: GITHUB_CREATE_PULL_REQUEST_TOOL, handler: createPullRequestTool(client, opts), unavailableReason, standalone },
  ];
}
