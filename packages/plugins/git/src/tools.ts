import type { ToolInvokeMeta, ToolRegistration, ToolSpec } from "@flowlathe/core";
import {
  asStringArray,
  type ExecOutcome,
  gitRefSlot,
  guarded,
  intSlot,
  relativeTo,
  requireString,
  resolveWithinRoot,
  runArgv,
  sanitizeUntrustedText,
  scrubUntrustedText,
  textSlot,
  toolFail,
  toolOk,
} from "@flowlathe/plugin-common";
import {
  addArgv,
  commitArgv,
  createBranchArgv,
  diffArgv,
  listBranchesArgv,
  logArgv,
  pushArgv,
  revParseHeadArgv,
  showArgv,
  statusArgv,
  switchArgv,
} from "./commands.js";
import type { GitConfig } from "./config.js";

/**
 * The ten `git` tools (PLAN-GIT.md section 3/4.5). Handler order, identical across all ten and
 * matching every existing plugin: (1) validate every slot inside one try/catch, (2) build argv
 * via `commands.ts`, (3) `guarded("git", "<op>", () => runArgv(...))`, (4) map the `ExecOutcome`.
 *
 * A non-zero exit is a SUCCESSFUL tool call — returned as `toolFail` with git's own message. A
 * `guarded`-classified failure is reserved for "the tool could not run git at all" (spawn/ENOENT).
 */

const READ_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 120_000;
/** Generous — `runArgv` truncates rather than crashing if a git command's output exceeds this. */
const MAX_BUFFER_BYTES = 10_000_000;

const DIFF_MAX_CHARS = 12_000;

/** section 4.5's per-field cap table. */
const CAP = {
  /** author name, branch name, upstream */
  name: 200,
  /** file path (status, diff, branch list) */
  path: 500,
  /** commit subject */
  subject: 500,
  /** commit body (git_show) */
  body: 4_000,
  /** stderr (or, when git wrote nothing to stderr, stdout — see `extractGitMessage`) returned on
   *  a non-zero exit */
  stderr: 2_000,
} as const;

const LOG_LIMIT_DEFAULT = 20;
const LOG_LIMIT_MIN = 1;
const LOG_LIMIT_MAX = 100;
const STATUS_ENTRY_CAP = 200;
const BRANCH_CAP = 200;
const ADD_PATHS_MIN = 1;
const ADD_PATHS_MAX = 50;
const COMMIT_MESSAGE_MAX_CHARS = 4_000;

/** A NUL byte, built via `fromCharCode` rather than a literal escape in this file's own source —
 *  purely a legibility/tooling-safety choice for a source file, no behavioral difference. */
const NUL = String.fromCharCode(0);

/** True when `text` contains a NUL byte — the binary-content signal for `git_show`'s with-path
 *  shape (raw file bytes decoded as UTF-8; NUL survives that decode unmangled). */
function containsNulByte(text: string): boolean {
  return text.indexOf(NUL) !== -1;
}

/** Scrub, then slice by hand with an owned marker — never `sanitizeUntrustedText(text,
 *  maxLength)`, which would silently cut a caller's own marker back off. */
function truncateWithMarker(raw: string, maxChars: number, label: string): string {
  const scrubbed = scrubUntrustedText(raw, label);
  if (scrubbed.length <= maxChars) return scrubbed;
  return `${scrubbed.slice(0, maxChars)}\n[truncated ${maxChars} of ${scrubbed.length} chars]`;
}

/** Most subcommands write their failure message to stderr, but `git commit` with nothing staged
 *  writes its "nothing to commit, working tree clean" explanation to STDOUT with a non-zero exit
 *  and an EMPTY stderr (verified against a real git 2.43 repo before writing this) — so the
 *  fallback to stdout is load-bearing, not defensive padding. */
function extractGitMessage(outcome: ExecOutcome): string {
  const stderr = outcome.stderr.trim();
  const stdout = outcome.stdout.trim();
  const raw = stderr || stdout || `git exited with code ${outcome.exitCode ?? "unknown"}`;
  return sanitizeUntrustedText(raw, CAP.stderr, "git stderr");
}

type GitAttempt = { ok: true; outcome: ExecOutcome } | { ok: false; result: string };

async function execGitTool(cfg: GitConfig, argv: string[], meta: ToolInvokeMeta, op: string, timeoutMs = READ_TIMEOUT_MS): Promise<GitAttempt> {
  const attempt = await guarded("git", op, () => runArgv("git", argv, { env: cfg.env, timeoutMs, maxBuffer: MAX_BUFFER_BYTES, signal: meta.signal }));
  if (!attempt.ok) {
    return { ok: false, result: toolFail(attempt.error) };
  }
  const outcome = attempt.data;
  if (outcome.timedOut) {
    return { ok: false, result: toolFail(`git ${op} timed out after ${timeoutMs}ms`) };
  }
  if (outcome.exitCode !== 0) {
    return { ok: false, result: toolFail(extractGitMessage(outcome)) };
  }
  return { ok: true, outcome };
}

type PathResolution = { ok: true; relative: string } | { ok: false; result: string };

/** Resolves a model-supplied path within `cfg.root`, returning it repo-relative (what every
 *  argv template wants after `--`). A rejection is `toolFail` carrying `resolveWithinRoot`'s own
 *  `Blocked:`-prefixed reason, matching `url-safety.ts`'s convention — and returned BEFORE any
 *  argv is built, so a path escape never reaches a subprocess at all. */
function resolvePathSlot(cfg: GitConfig, rawPath: string): PathResolution {
  const verdict = resolveWithinRoot(cfg.root, rawPath);
  if (!verdict.ok) {
    return { ok: false, result: toolFail(verdict.reason ?? `Blocked: path "${rawPath}" is not allowed`) };
  }
  return { ok: true, relative: relativeTo(cfg.root, verdict.path ?? cfg.root) };
}

// ---------------------------------------------------------------------------------------------
// git_status
// ---------------------------------------------------------------------------------------------

export const GIT_STATUS_TOOL: ToolSpec = {
  name: "git_status",
  description: "Show the working tree status: current branch, upstream tracking, and changed/staged/untracked files.",
  parameters: { type: "object", properties: {}, required: [] },
};

interface StatusEntry {
  path: string;
  indexStatus: string;
  workTreeStatus: string;
}

/** `git status --porcelain=v2 --branch --untracked-files=normal` is line-oriented with no NUL
 *  terminator (unlike `git log -z`), so this is a best-effort split on whitespace — a path
 *  containing a literal space is rare and not specially handled here, matching this codebase's
 *  existing accepted-and-documented latent parsing gaps (`git-history.ts`'s record-separator
 *  note, this plugin's own `-z`-fields-still-%x1f-separated note below). */
function parseStatusPorcelain(output: string) {
  const lines = output.split("\n").filter((l) => l.length > 0);
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const rawEntries: StatusEntry[] = [];

  for (const line of lines) {
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith("# ")) {
      continue; // branch.oid and any other header we don't need
    } else if (line.startsWith("1 ") || line.startsWith("2 ")) {
      const tokens = line.split(" ");
      const xy = tokens[1] ?? "..";
      const pathField = (line.startsWith("2 ") ? tokens.slice(9) : tokens.slice(8)).join(" ");
      const path = pathField.split("\t")[0] ?? pathField;
      rawEntries.push({ path, indexStatus: xy[0] ?? ".", workTreeStatus: xy[1] ?? "." });
    } else if (line.startsWith("u ")) {
      const tokens = line.split(" ");
      const xy = tokens[1] ?? "..";
      rawEntries.push({ path: tokens.slice(10).join(" "), indexStatus: xy[0] ?? ".", workTreeStatus: xy[1] ?? "." });
    } else if (line.startsWith("? ")) {
      rawEntries.push({ path: line.slice(2), indexStatus: "?", workTreeStatus: "?" });
    }
    // "!" (ignored) lines never appear — --ignored is never passed.
  }

  const truncated = rawEntries.length > STATUS_ENTRY_CAP;
  const entries = rawEntries.slice(0, STATUS_ENTRY_CAP).map((e) => ({
    path: sanitizeUntrustedText(e.path, CAP.path, "git status path"),
    indexStatus: e.indexStatus,
    workTreeStatus: e.workTreeStatus,
  }));

  return {
    branch,
    upstream: upstream !== null ? sanitizeUntrustedText(upstream, CAP.name, "git status upstream") : null,
    ahead,
    behind,
    entries,
    truncated,
  };
}

function gitStatusTool(cfg: GitConfig): ToolRegistration["handler"] {
  return async (_args, meta) => {
    const attempt = await execGitTool(cfg, statusArgv(cfg.root), meta, "status");
    if (!attempt.ok) return attempt.result;
    return toolOk(parseStatusPorcelain(attempt.outcome.stdout));
  };
}

// ---------------------------------------------------------------------------------------------
// git_log
// ---------------------------------------------------------------------------------------------

export const GIT_LOG_TOOL: ToolSpec = {
  name: "git_log",
  description: "Show commit history, newest first.",
  parameters: {
    type: "object",
    properties: {
      limit: { type: "number", description: "max commits, 1-100 (default 20)" },
      ref: { type: "string", description: "branch, tag, or sha to start from (default: current HEAD)" },
      path: { type: "string", description: "only commits touching this repo-relative path" },
    },
    required: [],
  },
};

/** `-z` terminates each record with NUL (impossible in a commit object), so record splitting is
 *  exact — fields within a record are still `%x1f`-separated, which a commit subject could in
 *  principle contain (`git-history.ts` has the identical latent issue; accepted, not overlooked).
 *  Sanitize AFTER splitting, never before: scrubbing strips control characters, and both NUL and
 *  the unit separator are control characters — reversing the order would collapse every record
 *  and every field into one. */
function parseLog(output: string): Array<{ sha: string; date: string; author: string; subject: string }> {
  const records = output.split(NUL).filter((r) => r.length > 0);
  return records.map((record) => {
    const [sha, date, author, subject] = record.split("\x1f");
    return {
      sha: sha ?? "",
      date: date ?? "",
      author: sanitizeUntrustedText(author ?? "", CAP.name, "git log author"),
      subject: sanitizeUntrustedText(subject ?? "", CAP.subject, "git log subject"),
    };
  });
}

function gitLogTool(cfg: GitConfig): ToolRegistration["handler"] {
  return async (args, meta) => {
    let limit: number;
    let ref: string | undefined;
    try {
      limit = args["limit"] !== undefined ? intSlot(args["limit"], "limit", LOG_LIMIT_MIN, LOG_LIMIT_MAX) : LOG_LIMIT_DEFAULT;
      ref = typeof args["ref"] === "string" ? gitRefSlot(args["ref"], "ref") : undefined;
    } catch (err) {
      return toolFail((err as Error).message);
    }
    let path: string | undefined;
    if (typeof args["path"] === "string") {
      const resolved = resolvePathSlot(cfg, args["path"]);
      if (!resolved.ok) return resolved.result;
      path = resolved.relative;
    }
    const attempt = await execGitTool(
      cfg,
      logArgv(cfg.root, { limit, ...(ref !== undefined ? { ref } : {}), ...(path !== undefined ? { path } : {}) }),
      meta,
      "log",
    );
    if (!attempt.ok) return attempt.result;
    return toolOk(parseLog(attempt.outcome.stdout));
  };
}

// ---------------------------------------------------------------------------------------------
// git_diff
// ---------------------------------------------------------------------------------------------

export const GIT_DIFF_TOOL: ToolSpec = {
  name: "git_diff",
  description: "Show a diff: working tree vs a ref, staged vs HEAD, or between two refs.",
  parameters: {
    type: "object",
    properties: {
      fromRef: { type: "string", description: "diff from this ref (default: working tree base)" },
      toRef: { type: "string", description: "diff to this ref — requires fromRef" },
      path: { type: "string", description: "limit the diff to this repo-relative path" },
      staged: { type: "boolean", description: "diff the index (staged changes) instead of the working tree" },
    },
    required: [],
  },
};

function gitDiffTool(cfg: GitConfig): ToolRegistration["handler"] {
  return async (args, meta) => {
    let fromRef: string | undefined;
    let toRef: string | undefined;
    let staged: boolean | undefined;
    try {
      fromRef = typeof args["fromRef"] === "string" ? gitRefSlot(args["fromRef"], "fromRef") : undefined;
      toRef = typeof args["toRef"] === "string" ? gitRefSlot(args["toRef"], "toRef") : undefined;
      staged = typeof args["staged"] === "boolean" ? args["staged"] : undefined;
    } catch (err) {
      return toolFail((err as Error).message);
    }
    if (toRef !== undefined && fromRef === undefined) {
      return toolFail('invalid toRef: requires "fromRef" to also be given');
    }
    let path: string | undefined;
    if (typeof args["path"] === "string") {
      const resolved = resolvePathSlot(cfg, args["path"]);
      if (!resolved.ok) return resolved.result;
      path = resolved.relative;
    }
    const attempt = await execGitTool(
      cfg,
      diffArgv(cfg.root, {
        ...(fromRef !== undefined ? { fromRef } : {}),
        ...(toRef !== undefined ? { toRef } : {}),
        ...(path !== undefined ? { path } : {}),
        ...(staged !== undefined ? { staged } : {}),
      }),
      meta,
      "diff",
    );
    if (!attempt.ok) return attempt.result;
    return toolOk({ diff: truncateWithMarker(attempt.outcome.stdout, DIFF_MAX_CHARS, "git diff") });
  };
}

// ---------------------------------------------------------------------------------------------
// git_show
// ---------------------------------------------------------------------------------------------

export const GIT_SHOW_TOOL: ToolSpec = {
  name: "git_show",
  description: "Show a commit (its metadata, message, and patch), or — with path — one file's contents at a revision.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "branch, tag, or sha" },
      path: { type: "string", description: "repo-relative path — returns that file's contents at ref instead of the commit" },
    },
    required: ["ref"],
  },
};

/** Splits the combined `sha` + unit-sep + `date` + unit-sep + `author` + unit-sep + `<message>`
 *  stream produced by `showArgv`'s no-path shape into structured metadata plus a separately
 *  capped patch — the `"\ndiff --git "` boundary is git's own patch-header marker (`--no-color`
 *  keeps it literal ASCII), verified against a real git 2.43 repo before writing this. A commit
 *  with no changes (e.g. an empty commit) has no such boundary; everything is then message body,
 *  `patch: ""`. */
function parseShowCommit(output: string): { sha: string; date: string; author: string; body: string; patch: string } {
  const firstSep = output.indexOf("\x1f");
  const sha = output.slice(0, firstSep);
  const afterSha = output.slice(firstSep + 1);
  const secondSep = afterSha.indexOf("\x1f");
  const date = afterSha.slice(0, secondSep);
  const afterDate = afterSha.slice(secondSep + 1);
  const thirdSep = afterDate.indexOf("\x1f");
  const author = afterDate.slice(0, thirdSep);
  const bodyAndPatch = afterDate.slice(thirdSep + 1);

  const diffMarker = "\ndiff --git ";
  const diffIdx = bodyAndPatch.indexOf(diffMarker);
  const body = diffIdx === -1 ? bodyAndPatch : bodyAndPatch.slice(0, diffIdx);
  const patch = diffIdx === -1 ? "" : bodyAndPatch.slice(diffIdx + 1);

  return {
    sha,
    date,
    author: sanitizeUntrustedText(author, CAP.name, "git show author"),
    body: sanitizeUntrustedText(body.trim(), CAP.body, "git show body"),
    patch: patch === "" ? "" : truncateWithMarker(patch, DIFF_MAX_CHARS, "git show patch"),
  };
}

function gitShowTool(cfg: GitConfig): ToolRegistration["handler"] {
  return async (args, meta) => {
    let ref: string;
    try {
      ref = gitRefSlot(requireString(args, "ref"), "ref");
    } catch (err) {
      return toolFail((err as Error).message);
    }

    if (typeof args["path"] === "string") {
      const resolved = resolvePathSlot(cfg, args["path"]);
      if (!resolved.ok) return resolved.result;
      const attempt = await execGitTool(cfg, showArgv(cfg.root, { ref, path: resolved.relative }), meta, "show");
      if (!attempt.ok) return attempt.result;
      if (containsNulByte(attempt.outcome.stdout)) {
        return toolFail(`Blocked: "${resolved.relative}" at "${ref}" appears to be binary — refusing to return it as text`);
      }
      return toolOk({ ref, path: resolved.relative, content: truncateWithMarker(attempt.outcome.stdout, DIFF_MAX_CHARS, "git show file") });
    }

    const attempt = await execGitTool(cfg, showArgv(cfg.root, { ref }), meta, "show");
    if (!attempt.ok) return attempt.result;
    return toolOk(parseShowCommit(attempt.outcome.stdout));
  };
}

// ---------------------------------------------------------------------------------------------
// git_list_branches
// ---------------------------------------------------------------------------------------------

export const GIT_LIST_BRANCHES_TOOL: ToolSpec = {
  name: "git_list_branches",
  description: "List local branches.",
  parameters: { type: "object", properties: {}, required: [] },
};

function parseBranches(output: string): Array<{ name: string; sha: string; upstream: string | null; current: boolean }> {
  const lines = output.split("\n").filter((l) => l.length > 0);
  return lines.slice(0, BRANCH_CAP).map((line) => {
    const [headMarker, name, sha, upstream] = line.split("\x1f");
    return {
      name: sanitizeUntrustedText(name ?? "", CAP.name, "git branch name"),
      sha: sha ?? "",
      upstream: upstream ? sanitizeUntrustedText(upstream, CAP.name, "git branch upstream") : null,
      current: headMarker === "*",
    };
  });
}

function gitListBranchesTool(cfg: GitConfig): ToolRegistration["handler"] {
  return async (_args, meta) => {
    const attempt = await execGitTool(cfg, listBranchesArgv(cfg.root), meta, "list_branches");
    if (!attempt.ok) return attempt.result;
    return toolOk(parseBranches(attempt.outcome.stdout));
  };
}

// ---------------------------------------------------------------------------------------------
// git_add (rw only)
// ---------------------------------------------------------------------------------------------

export const GIT_ADD_TOOL: ToolSpec = {
  name: "git_add",
  description: "Stage one or more repo-relative paths for the next commit.",
  parameters: {
    type: "object",
    properties: {
      paths: { type: "string", description: "repo-relative path(s) to stage, as a JSON array or comma-separated list" },
    },
    required: ["paths"],
  },
};

function gitAddTool(cfg: GitConfig): ToolRegistration["handler"] {
  return async (args, meta) => {
    const rawPaths = asStringArray(args["paths"]);
    if (rawPaths.length < ADD_PATHS_MIN || rawPaths.length > ADD_PATHS_MAX) {
      return toolFail(`invalid paths: expected ${ADD_PATHS_MIN}-${ADD_PATHS_MAX} entries, got ${rawPaths.length}`);
    }
    const relativePaths: string[] = [];
    for (const rawPath of rawPaths) {
      const resolved = resolvePathSlot(cfg, rawPath);
      if (!resolved.ok) return resolved.result;
      relativePaths.push(resolved.relative);
    }
    const attempt = await execGitTool(cfg, addArgv(cfg.root, relativePaths), meta, "add");
    if (!attempt.ok) return attempt.result;
    return toolOk({ staged: relativePaths });
  };
}

// ---------------------------------------------------------------------------------------------
// git_commit (rw only)
// ---------------------------------------------------------------------------------------------

export const GIT_COMMIT_TOOL: ToolSpec = {
  name: "git_commit",
  description: "Record a commit from whatever is currently staged (see git_add). Runs the repository's commit hooks.",
  parameters: {
    type: "object",
    properties: {
      message: { type: "string", description: "commit message" },
    },
    required: ["message"],
  },
};

function gitCommitTool(cfg: GitConfig): ToolRegistration["handler"] {
  return async (args, meta) => {
    let message: string;
    try {
      message = textSlot(args["message"], "message", COMMIT_MESSAGE_MAX_CHARS);
    } catch (err) {
      return toolFail((err as Error).message);
    }
    const commitAttempt = await execGitTool(cfg, commitArgv(cfg.root, message), meta, "commit");
    if (!commitAttempt.ok) return commitAttempt.result;

    const revParseAttempt = await execGitTool(cfg, revParseHeadArgv(cfg.root), meta, "commit");
    if (!revParseAttempt.ok) return revParseAttempt.result;
    const sha = revParseAttempt.outcome.stdout.trim();
    const subject = sanitizeUntrustedText(message.split("\n")[0] ?? "", CAP.subject, "git commit subject");
    return toolOk({ sha, subject });
  };
}

// ---------------------------------------------------------------------------------------------
// git_create_branch (rw only)
// ---------------------------------------------------------------------------------------------

export const GIT_CREATE_BRANCH_TOOL: ToolSpec = {
  name: "git_create_branch",
  description: "Create and switch to a new branch.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "new branch name" },
      fromRef: { type: "string", description: "base ref (default: current HEAD)" },
    },
    required: ["name"],
  },
};

function gitCreateBranchTool(cfg: GitConfig): ToolRegistration["handler"] {
  return async (args, meta) => {
    let name: string;
    let fromRef: string | undefined;
    try {
      name = gitRefSlot(requireString(args, "name"), "name");
      fromRef = typeof args["fromRef"] === "string" ? gitRefSlot(args["fromRef"], "fromRef") : undefined;
    } catch (err) {
      return toolFail((err as Error).message);
    }
    // No separate "does this branch already exist" pre-check/subprocess: `switch --create`
    // itself refuses ("fatal: a branch named '<name>' already exists") with a non-zero exit,
    // which `execGitTool` already turns into an ordinary toolFail — the same "let git's own
    // refusal be the answer" pattern every other write tool here uses.
    const attempt = await execGitTool(cfg, createBranchArgv(cfg.root, { name, ...(fromRef !== undefined ? { fromRef } : {}) }), meta, "create_branch");
    if (!attempt.ok) return attempt.result;
    return toolOk({ branch: name });
  };
}

// ---------------------------------------------------------------------------------------------
// git_switch (rw only)
// ---------------------------------------------------------------------------------------------

export const GIT_SWITCH_TOOL: ToolSpec = {
  name: "git_switch",
  description: "Switch the working tree to an existing branch. Refuses if the working tree has conflicting local changes.",
  parameters: {
    type: "object",
    properties: {
      ref: { type: "string", description: "branch to switch to" },
    },
    required: ["ref"],
  },
};

function gitSwitchTool(cfg: GitConfig): ToolRegistration["handler"] {
  return async (args, meta) => {
    let ref: string;
    try {
      ref = gitRefSlot(requireString(args, "ref"), "ref");
    } catch (err) {
      return toolFail((err as Error).message);
    }
    const attempt = await execGitTool(cfg, switchArgv(cfg.root, ref), meta, "switch");
    if (!attempt.ok) return attempt.result;
    return toolOk({ branch: ref });
  };
}

// ---------------------------------------------------------------------------------------------
// git_push (rw + GIT_TOOL_ALLOW_PUSH=1 only)
// ---------------------------------------------------------------------------------------------

export const GIT_PUSH_TOOL: ToolSpec = {
  name: "git_push",
  description: "Push the current branch (HEAD) to its same-named counterpart on the configured remote.",
  parameters: { type: "object", properties: {}, required: [] },
};

function gitPushTool(cfg: GitConfig): ToolRegistration["handler"] {
  return async (_args, meta) => {
    const attempt = await execGitTool(cfg, pushArgv(cfg.root, cfg.remote), meta, "push", PUSH_TIMEOUT_MS);
    if (!attempt.ok) return attempt.result;
    return toolOk({ pushed: true, remote: cfg.remote });
  };
}

// ---------------------------------------------------------------------------------------------
// Toolset assembly
// ---------------------------------------------------------------------------------------------

/**
 * `unavailableReason` is never set on any of these — per `config.ts`'s doc comment, boot-time
 * config resolution is the only I/O this plugin does outside a tool call, and there is nothing
 * left to probe once it has already validated the root (Fact 4/PLAN-GIT.md section 4.3). Every
 * registration carries the same `standalone` descriptor (L10): config is env-only, so an
 * exported script can reconstruct this toolset the same way SearXNG/Firecrawl's do.
 */
const GIT_STANDALONE: NonNullable<ToolRegistration["standalone"]> = {
  module: "@flowlathe/plugin-git",
  factory: "gitToolsetFromEnv",
  env: ["GIT_TOOL_ROOT", "GIT_TOOL_MODE", "GIT_TOOL_ALLOW_PUSH", "GIT_TOOL_REMOTE"],
};

function registration(spec: ToolSpec, handler: ToolRegistration["handler"]): ToolRegistration {
  return { toolset: "git", spec, handler, standalone: GIT_STANDALONE };
}

export function createGitToolset(cfg: GitConfig): ToolRegistration[] {
  const readTools: ToolRegistration[] = [
    registration(GIT_STATUS_TOOL, gitStatusTool(cfg)),
    registration(GIT_LOG_TOOL, gitLogTool(cfg)),
    registration(GIT_DIFF_TOOL, gitDiffTool(cfg)),
    registration(GIT_SHOW_TOOL, gitShowTool(cfg)),
    registration(GIT_LIST_BRANCHES_TOOL, gitListBranchesTool(cfg)),
  ];
  if (cfg.mode !== "rw") {
    return readTools;
  }
  const writeTools: ToolRegistration[] = [
    ...readTools,
    registration(GIT_ADD_TOOL, gitAddTool(cfg)),
    registration(GIT_COMMIT_TOOL, gitCommitTool(cfg)),
    registration(GIT_CREATE_BRANCH_TOOL, gitCreateBranchTool(cfg)),
    registration(GIT_SWITCH_TOOL, gitSwitchTool(cfg)),
  ];
  if (!cfg.allowPush) {
    return writeTools;
  }
  return [...writeTools, registration(GIT_PUSH_TOOL, gitPushTool(cfg))];
}
