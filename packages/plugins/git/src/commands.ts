/**
 * The ten argv templates (PLAN-GIT.md §3/§4.4) — the entire security design (L1) lives here.
 * Every function is a pure mapping from already-validated slots to a literal `string[]`; none of
 * them does I/O, touches `ToolInvokeMeta`, or accepts a subcommand or a flag from a caller. That
 * purity is what makes `commands.test.ts` possible: it asserts the exact argv array a set of
 * arguments produces, which is what catches a flag leaking into a slot.
 *
 * Two rules hold for every template without exception:
 * - every argv starts `["-C", root, …]` (L2) — the child's cwd is never inherited or influenced;
 * - every pathspec is immediately preceded by a literal `"--"` (L4) — what stops git from
 *   treating a path as an option.
 *
 * An absent optional slot removes its argv element entirely, never passes an empty string —
 * `git log ""` is not `git log`.
 */

export function statusArgv(root: string): string[] {
  return ["-C", root, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"];
}

export interface LogSlots {
  limit: number;
  ref?: string;
  /** Already repo-relative (resolved via `resolveWithinRoot` + `relativeTo` before this is
   *  called). */
  path?: string;
}

export function logArgv(root: string, slots: LogSlots): string[] {
  const argv = ["-C", root, "log", "-z", `--max-count=${slots.limit}`, "--format=%H%x1f%aI%x1f%an%x1f%s"];
  if (slots.ref !== undefined) {
    argv.push(slots.ref);
  }
  if (slots.path !== undefined) {
    argv.push("--", slots.path);
  }
  return argv;
}

export interface DiffSlots {
  fromRef?: string;
  /** Only meaningful together with `fromRef` — the caller (tools.ts) is responsible for never
   *  supplying `toRef` alone. */
  toRef?: string;
  path?: string;
  staged?: boolean;
}

/**
 * Builds the `from..to` range itself out of two independently validated refs — this is the
 * prepared-statement pattern in its clearest form: the `..` operator is syntax this template
 * owns, never a single model-supplied string (`"a..b"` is one edit away from `"a --output=/etc/x"`
 * if the model controlled the whole thing).
 */
export function diffArgv(root: string, slots: DiffSlots): string[] {
  const argv = ["-C", root, "diff", "--no-color", "--no-ext-diff"];
  if (slots.staged) {
    argv.push("--cached");
  }
  if (slots.fromRef !== undefined && slots.toRef !== undefined) {
    argv.push(`${slots.fromRef}..${slots.toRef}`);
  } else if (slots.fromRef !== undefined) {
    argv.push(slots.fromRef);
  }
  if (slots.path !== undefined) {
    argv.push("--", slots.path);
  }
  return argv;
}

export interface ShowSlots {
  ref: string;
  path?: string;
}

/** Two shapes, one tool: without `path`, the commit and its patch; with `path`, that file's
 *  contents at that revision (`‹ref›:‹path›`, both halves validated separately before being
 *  joined — same reasoning as `diffArgv`'s range). */
export function showArgv(root: string, slots: ShowSlots): string[] {
  if (slots.path !== undefined) {
    return ["-C", root, "show", "--no-color", `${slots.ref}:${slots.path}`];
  }
  return ["-C", root, "show", "--no-color", "--no-ext-diff", "--format=%H%x1f%aI%x1f%an%x1f%B", slots.ref];
}

export function listBranchesArgv(root: string): string[] {
  return ["-C", root, "branch", "--list", "--format=%(refname:short)%x1f%(objectname:short)%x1f%(upstream:short)"];
}

/** `paths` are already repo-relative and pre-validated (`resolveWithinRoot` + `relativeTo`, one
 *  per entry) — never `-A`/`--all`/`-u`/`-p`, staging is always this explicit list. */
export function addArgv(root: string, paths: readonly string[]): string[] {
  return ["-C", root, "add", "--", ...paths];
}

/** Never `--amend` (history rewriting, L8), never `-a`/`--all` (staging is `git_add`'s job),
 *  never `--no-verify` (hooks run, deliberately — the operator's own repository configuration). */
export function commitArgv(root: string, message: string): string[] {
  return ["-C", root, "commit", "--cleanup=whitespace", "-m", message];
}

/** No model-supplied slot at all — reads the commit `git_commit` just made, so the tool can
 *  return `{sha, subject}` without git printing anything the caller has to re-parse from
 *  `commitArgv`'s own stdout. */
export function revParseHeadArgv(root: string): string[] {
  return ["-C", root, "rev-parse", "HEAD"];
}

export interface CreateBranchSlots {
  name: string;
  fromRef?: string;
}

/** `switch --create`, not `checkout -b`: `switch` is the modern, narrower command with no
 *  file-restoring behavior to accidentally reach. */
export function createBranchArgv(root: string, slots: CreateBranchSlots): string[] {
  const argv = ["-C", root, "switch", "--create", slots.name];
  if (slots.fromRef !== undefined) {
    argv.push(slots.fromRef);
  }
  return argv;
}

/** No `--force`, `--detach`, `--discard-changes`, `-c` — a dirty work tree makes git itself
 *  refuse, and that refusal is the correct answer. */
export function switchArgv(root: string, ref: string): string[] {
  return ["-C", root, "switch", ref];
}

/** `remote` always comes from `GIT_TOOL_REMOTE` (config, never the model) and the target is
 *  always literally `HEAD` — there is no refspec slot at all. Produces the exact same three
 *  trailing elements for every input, because there is no input. */
export function pushArgv(root: string, remote: string): string[] {
  return ["-C", root, "push", remote, "HEAD"];
}
