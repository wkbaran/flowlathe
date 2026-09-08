import { execFileSync } from "node:child_process";
import type { FlowGraph } from "@flowlathe/core";
import { parse } from "@flowlathe/dsl";

export interface GitCommitInfo {
  sha: string;
  date: string;
  message: string;
}

const RECORD_SEP = "";

/** Every call here is read-only — PLAN-FLOW-VERSIONING.md §5/§9 design trap 5: "Don't auto-commit
 *  to the user's git repo. Ever." `stdio: ["ignore", "pipe", "ignore"]` also keeps a missing-git
 *  or not-a-repo failure silent (no stderr noise) rather than throwing — see the callers below,
 *  which all treat `undefined` as "the git tab simply doesn't render." */
function git(dir: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

/** True only when `dir` is inside a real git work tree. Checked before anything else here so an
 *  operator who never put `FLOWLATHE_FLOWS_DIR` under git just never sees the tab. */
export function isGitWorkTree(dir: string): boolean {
  return git(dir, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

/** `git log --follow` for one flow's file, newest first. Empty (not an error) for a file git has
 *  never tracked — e.g. an uncommitted flow. */
export function listGitHistory(dir: string, slug: string): GitCommitInfo[] {
  const out = git(dir, ["log", "--follow", `--format=%H${RECORD_SEP}%aI${RECORD_SEP}%s`, "--", `${slug}.flow`]);
  if (!out) return [];
  return out
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, date, message] = line.split(RECORD_SEP);
      return { sha: sha!, date: date!, message: message ?? "" };
    });
}

/** Legitimate values only ever come from `listGitHistory`'s `%H` output. Enforced before `sha`
 *  reaches an argv slot: `execFileSync` blocks shell injection but not argument injection, and a
 *  value starting with `-` is parsed by git as an option (e.g. `git show --output=<file>`), which
 *  can write attacker-controlled content to an attacker-chosen path. */
const SHA_PATTERN = /^[0-9a-fA-F]{4,40}$/;

/** The flow's graph as of one commit, via `git show <sha>:<path>` — undefined if the commit or the
 *  file at that commit can't be read, or doesn't parse as a `.flow` file (a rename `--follow`
 *  couldn't resolve, a commit predating the DSL, etc). Fed straight into the same `diffGraphs`
 *  every other diff view uses — no separate git-specific diff logic. */
export function graphAtGitCommit(dir: string, slug: string, sha: string): FlowGraph | undefined {
  if (!SHA_PATTERN.test(sha)) return undefined;
  const text = git(dir, ["show", `${sha}:${slug}.flow`]);
  if (text === undefined) return undefined;
  try {
    return parse(text).graph;
  } catch {
    return undefined;
  }
}
