import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import type { ToolRegistration } from "@flowlathe/core";
import { createGitToolset } from "./tools.js";

/**
 * Boot-time configuration for `@flowlathe/plugin-git` (PLAN-GIT.md §4.3). One repository
 * (`GIT_TOOL_ROOT`, L3), a structural read/write mode (L6), and push as a third opt-in on top of
 * `rw` (L7) — all resolved once, here, and never re-probed on a request path.
 */
export interface GitConfig {
  /** realpath'd, verified git work tree. */
  root: string;
  /** The fully-built child environment (L5) — carried PATH/HOME/TZ/SSH_AUTH_SOCK, plus
   *  LANG/GIT_TERMINAL_PROMPT/GIT_PAGER/GIT_OPTIONAL_LOCKS. Nothing else — no plugin credential,
   *  no FLOWLATHE_*, no GITHUB_TOKEN. */
  env: Record<string, string>;
  mode: "ro" | "rw";
  allowPush: boolean;
  /** `GIT_TOOL_REMOTE` ?? "origin" — never model-supplied (see `git_push`). */
  remote: string;
}

/** Mirrors `isGitWorkTree` in `packages/server/src/git-history.ts` — duplicated rather than
 *  imported because that file lives in `@flowlathe/server`, which this plugin cannot depend on
 *  (the dependency direction the other way around: server depends on plugins, never the reverse).
 *  `execFileSync` with fully literal argv, no shell (L2). */
function isGitWorkTree(root: string): boolean {
  try {
    const out = execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

/** L5's child environment, built (never inherited wholesale) — but with a bigger carry-list than
 *  `PLAN-SHELL-TOOL.md`'s, and `HOME`/`PATH` deliberately inherited rather than sandboxed: git
 *  needs `~/.gitconfig`, the credential helper and `ssh` to function at all, and that
 *  configuration is the operator's own (L9) — safe precisely because this plugin never runs
 *  `git config`/`git remote`, the two subcommands that would let a model *write* it.
 *  `GIT_TERMINAL_PROMPT=0` is not cosmetic: without it, a push with unusable credentials hangs on
 *  a terminal prompt until the timeout fires. */
function buildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const built: Record<string, string> = {
    PATH: env["PATH"] ?? "",
    HOME: env["HOME"] ?? "",
    LANG: "C.UTF-8",
    TZ: env["TZ"] ?? "UTC",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const sshAuthSock = env["SSH_AUTH_SOCK"];
  if (sshAuthSock !== undefined) {
    built["SSH_AUTH_SOCK"] = sshAuthSock;
  }
  return built;
}

/**
 * `undefined` (⇒ zero tool registrations, per the repo-wide "unset env var ⇒ zero registrations"
 * rule) when `GIT_TOOL_ROOT` is unset, doesn't exist, isn't a directory, or isn't a git work
 * tree — each with its own `console.warn`. This realpath+directory+work-tree check is the ONLY
 * filesystem or subprocess work this plugin does outside a tool call, and it happens once, here:
 * `unavailableReason` is never set on any registration this plugin contributes, because it runs
 * synchronously on `/run`, `/step-start`, and every `GraphEngine` construction (including
 * step-mode restores) — there is nothing left to probe once boot has already validated the root.
 *
 * `GIT_TOOL_MODE` anything other than `"rw"` is treated as `"ro"` (fail closed on a typo, with a
 * warning for an unrecognized value). `GIT_TOOL_ALLOW_PUSH=1` is honored only when the mode is
 * already `"rw"` — set alone, it warns and is ignored rather than silently promoting the mode.
 */
export function gitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitConfig | undefined {
  const rawRoot = env["GIT_TOOL_ROOT"];
  if (!rawRoot) {
    return undefined;
  }
  if (!existsSync(rawRoot)) {
    console.warn(`[plugin-git] GIT_TOOL_ROOT "${rawRoot}" does not exist — the git toolset will not be registered`);
    return undefined;
  }
  const root = realpathSync(rawRoot);
  if (!lstatSync(root).isDirectory()) {
    console.warn(`[plugin-git] GIT_TOOL_ROOT "${rawRoot}" is not a directory — the git toolset will not be registered`);
    return undefined;
  }
  if (!isGitWorkTree(root)) {
    console.warn(`[plugin-git] GIT_TOOL_ROOT "${rawRoot}" is not a git work tree — the git toolset will not be registered`);
    return undefined;
  }

  const modeRaw = env["GIT_TOOL_MODE"];
  let mode: "ro" | "rw" = "ro";
  if (modeRaw === "rw") {
    mode = "rw";
  } else if (modeRaw !== undefined && modeRaw !== "ro") {
    console.warn(`[plugin-git] GIT_TOOL_MODE "${modeRaw}" is neither "ro" nor "rw" — defaulting to "ro"`);
  }

  let allowPush = false;
  if (env["GIT_TOOL_ALLOW_PUSH"] === "1") {
    if (mode === "rw") {
      allowPush = true;
    } else {
      console.warn(`[plugin-git] GIT_TOOL_ALLOW_PUSH=1 has no effect without GIT_TOOL_MODE=rw — ignoring`);
    }
  }

  return {
    root,
    env: buildEnv(env),
    mode,
    allowPush,
    remote: env["GIT_TOOL_REMOTE"] ?? "origin",
  };
}

/** Named export a compiled, exported script calls to reconstruct this toolset from environment
 *  alone — see `ToolRegistration.standalone` and PLAN-INTEGRATIONS.md §4.4. Used the same way by
 *  the live server (`packages/server/src/index.ts`). `[]` for every reason `gitConfigFromEnv`
 *  returns `undefined` — the repo-wide "unset env var ⇒ zero tool registrations" rule. */
export function gitToolsetFromEnv(env: NodeJS.ProcessEnv = process.env): ToolRegistration[] {
  const cfg = gitConfigFromEnv(env);
  return cfg ? createGitToolset(cfg) : [];
}
