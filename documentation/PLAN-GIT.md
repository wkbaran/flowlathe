# PLAN-GIT — a `git` toolset built from prepared statements

Read `PLAN-DOMAIN-TOOLS.md` first: it holds why local git is a domain plugin rather than
something reached through `PLAN-SHELL-TOOL.md`'s allowlist (§1.1 — `git config core.pager` then
`git log` is arbitrary execution in two allowlisted calls), the prepared-statement principle (§2),
and the shared `slot-safety.ts` validators this plan consumes (§7).

This is Tier B work: a real subprocess, but one whose entire argv is written by the plugin author
except for named, typed value slots.

---

## 1. Problem

A flow that works on a codebase cannot see the codebase's history. It cannot read a diff, cannot
tell what is staged, cannot record a change. Local git has no HTTP API, so unlike
`PLAN-GITHUB.md` there is no way to avoid a subprocess — the question is only who writes the argv.

`PLAN-SHELL-TOOL.md`'s answer is "the model writes it, and we filter." That answer is wrong for
this specific command, demonstrably (`PLAN-DOMAIN-TOOLS.md` §1.1), and `git` is now hard-refused
by that plan's L11. This plan is the replacement.

### 1.1 Facts that shape the design

Verified in this repo before writing anything below:

1. **`packages/server/src/git-history.ts` is already a prepared-statement git client** — and was
   written before that framing existed. It runs `execFileSync("git", ["-C", dir, ...args])` with
   fully literal argv, validates its one caller-supplied value against `SHA_PATTERN` before it
   reaches an argv slot, and documents exactly why (`execFileSync` blocks shell injection but not
   *argument* injection — a `-`-prefixed value is parsed by git as an option). This plan
   generalizes that file's pattern; it does not invent it.
2. **`git-history.ts` deliberately swallows failure** (`stdio: ["ignore","pipe","ignore"]`,
   `catch { return undefined }`) so a missing git or a non-repo directory just means the git tab
   does not render. This plugin must do the opposite — a model needs to read git's stderr — so it
   cannot simply reuse that helper.
3. **Real git repositories are already created in this repo's tests**, not mocked:
   `packages/server/src/routes/flows-versioning.test.ts`'s "git history (Layer 2, S6)" block runs
   `git init`/`commit`/`show` for real. That precedent is what §6 follows.
4. **`unavailableReason()` is called synchronously on a request path** — `/run`, `/step-start`,
   and every `GraphEngine` construction including step-mode restores — so it must never do I/O.
   `PLAN-SHELL-TOOL.md` §4.2 already reasoned this through for a boot-validated config: there is
   nothing to probe, so the field is simply never set.
5. **"Unset env var ⇒ zero tool registrations" is locked and load-bearing** —
   `/api/plugins/status` derives `configured`/`connected` uniformly from live registrations.
6. **Tool results are sanitized at two layers** (PLAN-SANITIZATION-BOUNDARY.md): per-field at the
   source, plus a 32,000-char whole-result backstop that truncates blindly and would produce
   invalid JSON. Git output — commit messages, author names, file contents, diffs — is written by
   whoever's commits are in the repository.

---

## 2. Locked decisions

| # | Decision | Why |
|---|---|---|
| L1 | **The model never supplies a program, a subcommand, or a flag — only values.** Each tool owns a complete argv template; a model argument can only land in a named slot with a declared validator. | `PLAN-DOMAIN-TOOLS.md` §2. This is the entire security design; everything else is defense in depth. It is also what makes `git config`, aliases and `-c` structurally unreachable rather than blocklisted. |
| L2 | **`execFile`, never `exec`, never a `shell` option, and `git -C <root>` always leads the argv.** | No shell parser to defeat (`PLAN-SHELL-TOOL.md` L1's reasoning, which stays correct), and `-C` means the child's cwd is never inherited or model-influenced — `git-history.ts`'s existing shape. |
| L3 | **One repository: `GIT_TOOL_ROOT`, required, `realpath`-resolved and verified to be a git work tree at boot.** Unset, missing, or not a work tree ⇒ zero registrations. | Fact 5. One root also means `path-safety.ts` has exactly one containment boundary to enforce. Multi-repo is deferred (§5). |
| L4 | **Every pathspec is preceded by a literal `--`, and every path is validated by `resolveWithinRoot` first.** | `--` is what stops git treating a path as an option; `resolveWithinRoot` is what stops a path leaving the repository. Both are needed — neither substitutes for the other. |
| L5 | **The child environment is built, not inherited — but the allowlist is bigger than `PLAN-SHELL-TOOL.md`'s, and `HOME` is deliberately the operator's real `HOME`.** Carried: `PATH`, `HOME`, `LANG`, `TZ`, `SSH_AUTH_SOCK`. Added: `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `GIT_OPTIONAL_LOCKS=0`. Nothing else — no `FIRECRAWL_API_KEY`, no `GITHUB_TOKEN`, no `credential.key` path. | The build-don't-inherit lesson is the same (a git hook runs arbitrary code with this environment). But the shell tool sets `HOME` to its sandbox root *because* a written config there is harmless; here `~/.gitconfig` and the credential helper are exactly what makes git work at all, and they are operator-authored (D4). `SSH_AUTH_SOCK` is required for an ssh remote. `GIT_TERMINAL_PROMPT=0` is not cosmetic: without it a push with unusable credentials **hangs** on a terminal prompt until the timeout. |
| L6 | **Mode is structural: `GIT_TOOL_MODE` ∈ `ro` (default) \| `rw`.** `ro` registers the five read tools only. | `PLAN-FILE-TOOL.md`'s L2: a registered-but-refusing write tool still reaches the model in `tools`. |
| L7 | **Push is a third opt-in, `GIT_TOOL_ALLOW_PUSH=1`, on top of `rw`.** | It is the only operation here that leaves the machine and affects other people. Everything else is local and recoverable from the reflog; a push is not. |
| L8 | **No history rewriting, no destructive local operations, no network reads.** No `reset`, `revert`, `rebase`, `merge`, `cherry-pick`, `stash`, `clean`, `rm`, `mv`, `checkout -- <path>`, `fetch`, `pull`, `clone`, `tag`, `submodule`, `worktree`, and above all no `config` or `remote`. See §5. | Uncommitted work a model discarded is gone. And `config`/`remote` are the two subcommands that would reintroduce `PLAN-DOMAIN-TOOLS.md` §1.1's attack outright. |
| L9 | **Auth, identity and remotes are configured by the operator by hand, outside flowlathe.** `user.name`/`user.email`, the credential helper, the remote URL. This plugin reads that configuration and never writes it. | `PLAN-DOMAIN-TOOLS.md` D4. A plugin that cannot write config cannot be used to write config. If identity is unset, `git commit` fails with git's own clear message, which reaches the model as an ordinary tool failure. |
| L10 | **`standalone` is set** (`gitToolsetFromEnv`), so an exported compiled script can use this toolset. | Config is env-only, like SearXNG/Firecrawl. The script must run on a machine where `GIT_TOOL_ROOT` exists — document that. |
| L11 | **No `git` node kind.** Toolset only. | `PLAN-DOMAIN-TOOLS.md` D6. |

---

## 3. The operations

Ten tools: five read, four write, one push. This is the minimal set for general software
development and version management — enough to see the state of the tree and its history, and to
record and publish a change.

Notation below: `‹slot›` is a model-supplied value with its validator; everything else in an argv
template is a literal written by the plugin author.

### 3.1 Read tools (always registered)

#### `git_status` — no arguments

```
git -C ‹root› status --porcelain=v2 --branch --untracked-files=normal
```

Returns `{branch, upstream, ahead, behind, entries: [{path, indexStatus, workTreeStatus}]}`,
entry list capped at 200 with a `truncated` flag.

`--porcelain=v2` rather than v1: it is the format git documents as stable for machine consumption
and it carries branch/ahead/behind in the same output, avoiding a second invocation.

#### `git_log`

```
git -C ‹root› log -z --max-count=‹limit› --format=%H%x1f%aI%x1f%an%x1f%s ‹ref› -- ‹path›
```

| Argument | Type | Required | Validation |
|---|---|---|---|
| `limit` | number | no | `intSlot(…, 1, 100)`, default 20 |
| `ref` | string | no | `gitRefSlot`; omitted ⇒ the argv element is omitted entirely, not passed empty |
| `path` | string | no | `resolveWithinRoot`, passed after `--` as a repo-relative path |

Returns `[{sha, date, author, subject}]`.

**`-z` is load-bearing.** It terminates each record with NUL, which cannot appear in a commit
object, so record splitting is exact. Fields within a record are still split on `%x1f`, which a
commit subject could in principle contain — `git-history.ts` has the identical latent issue with
its own record separator. Accepted, recorded here rather than discovered later; splitting records
correctly is the half that actually matters.

Note the omitted-argument rule: an unset optional slot must remove its argv element, never pass
an empty string. `git log ""` is not `git log`.

#### `git_diff`

```
git -C ‹root› diff --no-color --no-ext-diff [--cached] [‹fromRef›..‹toRef› | ‹fromRef›] -- ‹path›
```

| Argument | Type | Required | Validation |
|---|---|---|---|
| `fromRef` | string | no | `gitRefSlot` |
| `toRef` | string | no | `gitRefSlot`; requires `fromRef` |
| `path` | string | no | `resolveWithinRoot` |
| `staged` | boolean | no | default `false` ⇒ adds `--cached` |

The range is built by the plugin from two independently validated slots — `` `${from}..${to}` `` is
constructed here, never accepted as one string from the model. That is the prepared-statement
pattern in its clearest form: the `..` operator is syntax the template owns, and a model that
could pass `"a..b"` as one value could also pass `"a --output=/etc/x"`.

`--no-ext-diff` matters: without it git honors a `diff.external` config setting, which is another
config-file-names-a-command channel. The operator authored that config, so this is defense in
depth rather than a hole — but it costs one flag.

Output is scrubbed and capped at `DIFF_MAX_CHARS` (12,000) with its own truncation marker.

#### `git_show`

```
git -C ‹root› show --no-color --no-ext-diff --format=%H%x1f%aI%x1f%an%x1f%B ‹ref›
git -C ‹root› show --no-color ‹ref›:‹path›            # when `path` is given
```

| Argument | Type | Required | Validation |
|---|---|---|---|
| `ref` | string | yes | `gitRefSlot` |
| `path` | string | no | `resolveWithinRoot`, then made repo-relative |

Two shapes, one tool: without `path`, the commit and its patch; with `path`, that file's contents
at that revision. The second is the direct generalization of `git-history.ts`'s
`graphAtGitCommit` — same `‹ref›:‹path›` composition, same reason its two halves must be validated
separately before being joined.

Both bounded at `DIFF_MAX_CHARS`. Binary content is refused rather than returned: if the output
contains a NUL byte, reply `toolFail("Blocked: <path> at <ref> is binary")` — a binary blob in a
prompt is 12,000 characters of noise (`PLAN-FILE-TOOL.md` L7's reasoning).

#### `git_list_branches` — no arguments

```
git -C ‹root› branch --list --format=%(refname:short)%x1f%(objectname:short)%x1f%(upstream:short)
```

Returns `[{name, sha, upstream, current}]`, capped at 200. `--list` with no pattern is
deliberate: a pattern slot would be a glob the model authors, and listing everything is cheap.

### 3.2 Write tools (registered only when `GIT_TOOL_MODE=rw`)

#### `git_add`

```
git -C ‹root› add -- ‹path›...
```

| Argument | Type | Required | Validation |
|---|---|---|---|
| `paths` | string \| string[] | yes | `asStringArray`, 1–50 entries, each `resolveWithinRoot` |

No `-A`, no `--all`, no `-u`, no `-p`, no pathspec magic (`:(exclude)…` is rejected by
`resolveWithinRoot`'s own rules). Staging is always an explicit list, which is what makes
`git_commit`'s lack of `-a` meaningful.

#### `git_commit`

```
git -C ‹root› commit --cleanup=whitespace -m ‹message›
```

| Argument | Type | Required | Validation |
|---|---|---|---|
| `message` | string | yes | `textSlot(…, 4_000)` |

Returns `{sha, subject}` by reading `git rev-parse HEAD` after a successful commit.

Never `--amend` (rewrites history, L8), never `-a`/`--all` (staging is `git_add`'s explicit job),
never `--no-verify` (**hooks run**, deliberately — they are the operator's own repository
configuration, exactly as they would be if the operator typed the command).

`-m ‹message›` is safe against argument injection without a leading-dash check, because `-m`
consumes the next element as its value unconditionally. `textSlot` rejects a leading `-` anyway;
belt and braces, and it keeps one validator serving every text slot.

Identity comes from the operator's `~/.gitconfig` (L9). Unset ⇒ git's own "Please tell me who you
are" error reaches the model verbatim, which is the right outcome.

#### `git_create_branch`

```
git -C ‹root› switch --create ‹name› [‹fromRef›]
```

| Argument | Type | Required | Validation |
|---|---|---|---|
| `name` | string | yes | `gitRefSlot`, plus: rejected if a branch of that name already exists |
| `fromRef` | string | no | `gitRefSlot`; defaults to the current HEAD |

`switch --create` rather than `checkout -b`: `switch` is the modern, narrower command and has no
file-restoring behavior to accidentally reach.

#### `git_switch`

```
git -C ‹root› switch ‹ref›
```

| Argument | Type | Required | Validation |
|---|---|---|---|
| `ref` | string | yes | `gitRefSlot` |

No `--force`, no `--detach`, no `--discard-changes`, no `-c`. A dirty work tree makes git itself
refuse, and that refusal is the correct answer — do not add a flag to override it.

### 3.3 Push (registered only when `GIT_TOOL_MODE=rw` **and** `GIT_TOOL_ALLOW_PUSH=1`)

#### `git_push` — no arguments

```
git -C ‹root› push ‹remote-from-env› HEAD
```

The remote is `GIT_TOOL_REMOTE` (default `origin`), read from the environment, never from the
model. There is **no refspec slot at all**: `HEAD` pushes the current branch to its same-named
counterpart, which is the only thing a flow legitimately needs. No `--force`,
`--force-with-lease`, `--delete`, `--tags`, `--mirror`, `--set-upstream`, `-o`, or
`--receive-pack`.

A first push of a new branch with no upstream will fail with git's own advice; that is acceptable
and legible. Adding `--set-upstream` would mean a model deciding what a branch tracks.

This is the tool most worth gating behind `PLAN-TOOL-APPROVAL.md`'s per-tool-name grain
(`PLAN-DOMAIN-TOOLS.md` §8), and it pairs with `github_create_pull_request` — push here, open the
PR there.

---

## 4. Implementation

### 4.0 — scaffold

Copy `packages/plugins/searxng/{package.json,tsconfig.json}`, rename to `@flowlathe/plugin-git`.
Keep the pinned `typescript@5.9.3` / `vitest@5.0.0` versions **exactly** — do not resolve `latest`
for either (CLAUDE.md's TypeScript-7 entry). Dependencies are `@flowlathe/core` and
`@flowlathe/plugin-common` only; no HTTP, no vendor SDK.

### 4.1 — two shared primitives in `plugin-common`

Both are specified elsewhere and owned by whichever plan lands first. Create what does not exist
yet; consume what does.

- **`slot-safety.ts`** — `PLAN-DOMAIN-TOOLS.md` §7. This plan uses `gitRefSlot`, `intSlot` and
  `textSlot`. `PLAN-GITHUB.md` creates it if it lands first.
- **`resolveWithinRoot` — already exists; extract it, do not write it.** `PLAN-SHELL-TOOL.md` §9.1
  and earlier drafts of this section said to create it in `plugin-common`. That was **wrong**:
  `PLAN-STATE-FILES.md` already implemented it, with tests, at
  `packages/runtime/src/state-file-io.ts:53` (`PathVerdict`, the NUL / absolute / `~` / lexical-`..`
  / `realpathSync` / `root + sep` containment sequence, and a documented TOCTOU gap). Writing a
  second copy is the `url-safety.ts` ↔ `allowed-hosts.ts` duplication mistake this repo has already
  paid for once — see `documentation/notes/security.md`, where a set of SSRF gaps had to be
  independently re-derived and fixed in both files.

  It cannot simply be imported from where it is: `@flowlathe/plugin-common` must not depend on
  `@flowlathe/runtime` (runtime's transitive closure pulls in every node kind, and the locked
  direction is that plugin-common is a helper library *for* plugins, not for what plugins plug
  into). It cannot move into `@flowlathe/core` either — `realpathSync` is `node:fs` and core must
  stay isomorphic.

  **Resolution: extract it into a new, dependency-free Node-only package `@flowlathe/path-safety`
  (`packages/path-safety`)**, which both `@flowlathe/runtime` and `@flowlathe/plugin-common`
  depend on. `PLAN-SHELL-TOOL.md` §9.1 already sanctioned exactly this shape ("move it to a new
  Node-only shared package rather than into core"). This is a pure refactor — no behavior change,
  the existing tests move with it — and it is isolated as its own handoff chunk
  (`documentation/handoff/C5-git-shared-plumbing.md`) precisely so it lands green before anything
  depends on it. `PLAN-FILE-TOOL.md`, if it is ever built, becomes a third consumer instead of
  authoring a fourth copy.

  One addition this plan needs on top of the extracted module: `resolveWithinRoot` returns an
  absolute path, but git wants a repo-relative one after `--`. Add `relativeTo(root, absolute)`
  beside it rather than calling `path.relative` at each of the four call sites.

### 4.2 — `exec.ts` in `plugin-common`

`PLAN-SHELL-TOOL.md` §4.3's runner, promoted to `plugin-common` and owned by this plan instead —
so that plan later *inherits* it rather than authoring it. Same signature shape, no allowlist and
no wrapper (both are shell-tool concepts that have no meaning here):

```ts
export interface ExecOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export function runArgv(
  file: string,
  args: readonly string[],
  opts: { env: Record<string, string>; timeoutMs: number; maxBuffer: number; signal?: AbortSignal },
): Promise<ExecOutcome>;
```

Every one of these is a bug if omitted — they are `PLAN-SHELL-TOOL.md` §4.3's list, and they apply
identically here:

- **`execFile` with no `shell` option.** Node's default is `shell: false`; do not set it to
  anything, and never call `exec`.
- **`detached: true` + `process.kill(-pid)` on timeout or abort**, falling back to `child.kill()`
  on `ESRCH`. Node's `timeout`/`signal` kill the direct child only. Git spawns descendants
  routinely — `ssh` for a push, a credential helper, a pager if `GIT_PAGER` were ever unset, and
  every hook.
- **`maxBuffer`.** Exceeding it makes Node kill the child and reject with an error whose
  `stdout`/`stderr` properties still carry what was captured. Catch that case and return
  `truncated: true` — a `git log` on a large repository must read as truncated output, not a
  plugin crash.
- **`signal`** forwarded from `ToolInvokeMeta.signal`, so a git command participates in
  PLAN-CANCELLATION's cancel-and-drain rather than surviving a failed run in the background.
- **Never resolve before the child has exited.** Don't race the callback against a timer.

Timeouts: 15s default for every read tool, 120s for `git_push` (a real network operation with a
credential helper in the path). Not model-supplied — there is no `timeoutMs` slot, deliberately;
a fixed per-tool value is one fewer thing to validate and there is no legitimate reason for a
model to extend a push timeout.

### 4.3 — `config.ts`

```ts
export interface GitConfig {
  root: string;                        // realpath'd, verified work tree
  env: Record<string, string>;         // the fully-built child env (L5)
  mode: "ro" | "rw";
  allowPush: boolean;
  remote: string;                      // GIT_TOOL_REMOTE ?? "origin"
}

export function gitConfigFromEnv(env = process.env): GitConfig | undefined;
export function gitToolsetFromEnv(env = process.env): ToolRegistration[];
```

Returns `undefined` — zero registrations — when `GIT_TOOL_ROOT` is unset, does not exist, is not a
directory after `realpathSync`, or is not a git work tree. The work-tree check is
`git rev-parse --is-inside-work-tree` — the same call `isGitWorkTree` in `git-history.ts` already
makes. One `console.warn` per rejected reason at boot.

This is the **only** filesystem or subprocess work outside a tool call, and it happens once. Fact
4: `unavailableReason` must never do I/O, and here there is nothing to probe — config is either
valid at boot or the toolset does not exist. So `unavailableReason` is simply never set, exactly
as `PLAN-SHELL-TOOL.md` §4.2 reasoned for the same situation. Do not add a
`CachedLivenessProbe`; there is no remote state to be live about.

`GIT_TOOL_MODE` anything other than `rw` is `ro`, with a `console.warn` for an unrecognized value —
fail closed on a typo. `GIT_TOOL_ALLOW_PUSH` is only honored when the mode is already `rw`; set
alone it warns and is ignored.

Environment construction (L5) — the one place this plan deliberately diverges from
`PLAN-SHELL-TOOL.md`:

```
PATH          = process.env.PATH        // inherited: git must find ssh, a credential helper, hooks
HOME          = process.env.HOME        // inherited: ~/.gitconfig and the credential helper live here
LANG          = "C.UTF-8"               // stable, parseable output
TZ            = process.env.TZ ?? "UTC"
SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK   // only if set; required for an ssh remote
GIT_TERMINAL_PROMPT = "0"
GIT_PAGER           = "cat"
GIT_OPTIONAL_LOCKS  = "0"
```

and **nothing else** — no plugin credential, no `FLOWLATHE_*`, no `GITHUB_TOKEN`. A git hook is
arbitrary code running with this environment, so the shell plan's L4 lesson holds even though its
`HOME` decision inverts.

### 4.4 — `commands.ts`: the templates

One module holding the ten argv templates, each a pure function from validated slots to a
`string[]`. Keep them free of I/O and of `ToolInvokeMeta` so they are trivially unit-testable —
the test that asserts *what argv a set of arguments produces* is the highest-value test in this
plan, because it is the one that catches a flag leaking into a slot.

```ts
export function logArgv(root: string, slots: { limit: number; ref?: string; path?: string }): string[];
// → ["-C", root, "log", "-z", "--max-count=20", "--format=…", "main", "--", "src/x.ts"]
```

Every function starts `["-C", root, …]` (L2) and inserts `"--"` before any pathspec (L4).

### 4.5 — `tools.ts`

Handler order, identical in all ten and matching every existing plugin:

1. Validate every slot inside one try/catch ⇒ `toolFail((err as Error).message)` on `SlotError` or
   `PluginArgError`. Path slots resolve through `resolveWithinRoot`; a rejection is `toolFail`
   with its `Blocked:`-prefixed reason, matching `url-safety.ts`'s convention.
2. Build argv via `commands.ts`.
3. `guarded("git", "<op>", () => runArgv("git", argv, {...}))`.
4. Map the `ExecOutcome`.

**A non-zero exit is a successful tool call**, returned as `toolFail` with git's own stderr —
`PLAN-SHELL-TOOL.md` L7's reasoning: a model needs to read "nothing to commit, working tree
clean". Reserve a thrown/`guarded`-classified failure for "the tool could not run git at all".

**Sanitization (layer 1, mandatory).** Everything git prints was written by whoever authored the
commits, and on a shared repository that is not the operator. Per-field caps:

| Field | Cap |
|---|---|
| author name, branch name, upstream | 200 |
| file path (status, diff, branch list) | 500 |
| commit subject | 500 |
| commit body (`git_show`) | 4,000 |
| stderr returned on failure | 2,000 |
| diff / file content | 12,000 (own marker) |

Each uses `sanitizeUntrustedText(value, cap, "git <field>")`, as `summarizeMessage` in
`plugin-discord/src/tools.ts` does. The diff and file-content fields carry their own
`[truncated N of M chars]` marker, so they **scrub then slice by hand** and never pass a
`maxLength` to `sanitizeUntrustedText`, which would cut the marker back off (CLAUDE.md's rule).

Sanitize **after** splitting records, never before: scrubbing strips control characters, and the
field separators are control characters. Getting this backwards silently collapses every record
into one.

Worst-case envelope (`git_show` with a large patch: ~12k plus metadata) stays comfortably under
`tool-registry.ts`'s 32,000-char layer-2 backstop, which truncates blindly and would produce
invalid JSON.

### 4.6 — `manifest.ts` and server wiring

`GIT_MANIFEST` follows `SEARXNG_MANIFEST`'s shape: `toolset: "git"`, `displayName: "Git"`, a
description saying out loud that this runs git against a local repository, one `env` entry per
variable (`GIT_TOOL_ROOT` `required: true`; `GIT_TOOL_MODE`, `GIT_TOOL_ALLOW_PUSH`,
`GIT_TOOL_REMOTE` optional; none `secret`). No `connect`.

Two edits in `packages/server/src/index.ts`:

```ts
const pluginManifests: PluginManifest[] = [..., GIT_MANIFEST];
pluginToolsets = [...pluginToolsets, ..., ...gitToolsetFromEnv()];
```

Everything else falls out with no further code — status endpoint, Canvas checkbox,
`requiredToolsets`, the dependency banner, the `/run` and `/step-start` 409 gates. Verify rather
than assume (CLAUDE.md's MCP note).

---

## 5. Scope: deliberately not built

- **`config`, `remote`, `clone`.** These are precisely `PLAN-DOMAIN-TOOLS.md` §1.1's attack. A
  plugin that cannot write git configuration cannot be used to write git configuration. Never add
  them; if a future need appears, it is an operator action in their own shell (L9).
- **History rewriting: `reset`, `revert`, `rebase`, `commit --amend`, `filter-branch`.** L8.
- **Destructive local operations: `clean`, `rm`, `mv`, `checkout -- <path>`, `stash drop`.**
  Uncommitted work a model discarded is unrecoverable — unlike a bad commit, which is in the
  reflog.
- **`merge` and `cherry-pick`.** Both can leave the tree in a conflicted state this toolset has no
  vocabulary to resolve, and resolving conflicts is the thing a model is worst at.
- **`fetch` and `pull`.** The most likely first addition, and the shape is easy — `git -C ‹root›
  fetch ‹remote-from-env›` with no model slot at all, mirroring `git_push`. Cut from v1 only
  because the operator can fetch in their own shell, which is already the stated assumption (L9);
  `pull` should stay out regardless, since it merges.
- **`tag`, `submodule`, `worktree`, `bisect`, `notes`, `apply`/`am`, `blame`, `grep`.** Real
  operations, not part of a minimal loop. `blame` and `grep` are the most defensible additions
  after `fetch`.
- **Multiple repositories.** One `GIT_TOOL_ROOT` (L3). A `repo` slot would mean a second
  allowlist and a second containment root; the natural design if it is ever wanted is
  `GIT_TOOL_ROOTS` as a name→path map with the *name* as the slot, never a path.
- **A model-supplied timeout** (§4.2), **pathspec magic**, **glob patterns anywhere**.
- **A `git` node kind** (L11).

---

## 6. Testing

`vitest`, colocated `*.test.ts`. Real git repositories in temp directories, created with `git
init` — never mocked. Precedent: fact 3, plus `plugin-mcp`'s "spawn a real stdio server rather
than fake a transport" rule that CLAUDE.md records.

Every test repo is created with an explicit local identity
(`git -C <dir> config user.email …` / `user.name …` — the *test* may run `git config`; the plugin
never does) and `commit.gpgsign=false`, so the suite does not depend on the machine's global
gitconfig or a signing key.

### 6.1 `commands.test.ts` — pure, and the most valuable file here

Assert the exact argv array for every tool, for every combination of present/absent optional
slots. This is what catches a flag leaking into a slot, and it runs in microseconds:

- every template starts `["-C", root, …]`
- every pathspec is immediately preceded by `"--"`
- an absent optional `ref` removes its element entirely rather than passing `""`
- `git_diff` with both refs produces one `from..to` element, not two elements and not a
  model-supplied string
- `git_push` produces exactly `["-C", root, "push", remote, "HEAD"]` for every input — there is no
  input

### 6.2 `slot-safety.test.ts` (in `plugin-common`, if this plan creates it)

Per `PLAN-GITHUB.md` §6.1 — the same file serves both plans. If `PLAN-GITHUB.md` landed first, add
only what is missing here.

### 6.3 `config.test.ts`

- `gitToolsetFromEnv({})` ⇒ `[]`
- `GIT_TOOL_ROOT` pointing at a non-existent path, a plain file, and a directory that is not a
  work tree ⇒ `[]` with a warning each
- a real `git init` directory ⇒ 5 registrations in `ro`
- `GIT_TOOL_MODE=rw` ⇒ 9; plus `GIT_TOOL_ALLOW_PUSH=1` ⇒ 10
- `GIT_TOOL_ALLOW_PUSH=1` **without** `rw` ⇒ 5 and a warning
- `GIT_TOOL_MODE=nonsense` ⇒ 5 (fails closed) and a warning
- **the environment test, which is the important one**: plant `FIRECRAWL_API_KEY=leak` and
  `GITHUB_TOKEN=leak2` in the parent process, build the config, and assert neither name appears in
  `cfg.env`, while `HOME` and `PATH` do and `GIT_TERMINAL_PROMPT` is `"0"`. This one test is what
  stands between a git hook and every credential the server holds.

### 6.4 `tools.test.ts` — against real repositories

Build a fixture repo per test: `git init`, a couple of commits, a branch, a staged and an unstaged
change.

- each read tool returns the expected shape against a known history
- `git_add` + `git_commit` produces a real commit, verified by re-running `git log` through the
  tool itself
- `git_commit` with nothing staged returns `ok:false` carrying git's own message, and does **not**
  throw (the L7-equivalent non-zero-exit rule)
- `git_switch` to a nonexistent branch returns `ok:false` with git's message
- **a path outside the root is refused before git runs** — `path: "../../etc/passwd"` and an
  absolute path both `toolFail` with a `Blocked:` reason; assert no subprocess was spawned, not
  merely that the call failed
- **a ref that is a flag is refused before git runs** — `ref: "--output=/tmp/pwned"`,
  `ref: "-o"`, `ref: "a/../../b"`; same "never spawned" assertion. This is the `git-history.ts`
  regression, generalized
- a commit message containing zero-width and Unicode tag characters comes back scrubbed
- a diff longer than `DIFF_MAX_CHARS` carries its truncation marker **as the last thing in the
  string**, proving scrub-then-truncate
- `git_show` on a binary blob returns `ok:false` with the binary refusal, not 12k of noise
- **write tools are absent in `ro`**: assert by registration name, so the check cannot pass
  vacuously if a tool is renamed

### 6.5 `exec.test.ts` (in `plugin-common`)

The runner, tested directly with stock commands present on Linux and macOS — `sleep` for timeout
and cancellation, `printenv` for the built environment:

- a non-zero exit resolves with `exitCode: 1` and does not throw
- `timeoutMs` ⇒ `timedOut: true`, settling within a small multiple of the timeout
- **descendant kill**: a process that backgrounds a child which outlives it — assert the
  grandchild is gone after the timeout. Give this test an explicit vitest timeout; its failure
  mode is a hang, which otherwise just looks like a stuck suite (the lesson
  `run-graph.test.ts`'s suspend test recorded in CLAUDE.md).
- `maxBuffer` exceeded ⇒ `truncated: true` with partial stdout, no throw
- an aborted `signal` mid-run settles promptly with the child gone

### 6.6 Parity / golden fixtures

**No golden parity fixture.** The parity harness stubs the mock provider and (via `net-stub.ts`)
outbound HTTP; it has no stub for a subprocess, and a fixture that really shells out to `git`
would make the harness environment-dependent for the first time. Doing it properly needs a
`(nodeId, sha256(argv))`-keyed table mirroring `injectResponseTable` — the same design
PLAN-INTEGRATIONS.md's design trap 8 describes, and the same reason the `fetch`-node fixture was
deferred. Tracked, not hidden.

### 6.7 e2e

**No Playwright spec**, consistent with every plugin-shaped slice in this repo (CLAUDE.md records
that `playwright/tests/` has no spec for Spotify, Gate, MCP, SearXNG, Firecrawl or Discord).
Coverage is the unit suite plus a manual smoke test: point `GIT_TOOL_ROOT` at a scratch clone, add
a prompt node with the `git` toolset checked, confirm the dependency banner and the 409 gate when
it is unset, and run `git_status` → `git_log` → `git_add` → `git_commit` end to end.

---

## 7. Ordering

1. `slot-safety.ts` (if `PLAN-GITHUB.md` has not landed) and `path-safety.ts` + tests, in
   `plugin-common`.
2. `exec.ts` + tests in `plugin-common` (§4.2, §6.5). Nothing model-facing yet.
3. Package scaffold + `config.ts` + tests, including the credential-leak test.
4. `commands.ts` + its pure argv tests — before any handler exists.
5. `tools.ts` (read tools first, then write, then push) + `manifest.ts` + tests.
6. Server wiring, README, manual smoke test.
7. CLAUDE.md notes (§8).

Steps 1–2 are the only ones touching existing code and are independently revertible.

---

## 8. Notes to record (definition of done)

Add these to **`documentation/notes/plugins-and-tools.md`**, not to `CLAUDE.md` — that file is now
an index plus repo-wide invariants only, and these are plugin-scoped. The one exception is the
`@flowlathe/path-safety` extraction (§4.1), which belongs in
`documentation/notes/toolchain-and-build.md` since it changes the package graph. See CLAUDE.md's
"Adding a note" section.

- **`@flowlathe/plugin-git` never runs `git config` or `git remote`, and must never learn to.**
  Those two subcommands are the whole reason `git` is hard-refused by `PLAN-SHELL-TOOL.md`'s L11
  (`git config core.pager …` then `git log` is arbitrary execution in two calls). Identity, the
  credential helper and remotes are the operator's to configure by hand.
- **The model never supplies a subcommand or a flag** — `commands.ts` owns every argv template and
  a model argument can only reach a named, validated slot. `commands.test.ts` asserts the exact
  argv array for every tool; that file is what catches a flag leaking into a slot, and it is worth
  more than the rest of the suite combined.
- **`git_diff` builds its `from..to` range from two separately validated refs.** A single
  model-supplied `"a..b"` string would be a single model-supplied `"a --output=/etc/x"` string.
- **`HOME` and `PATH` are inherited here, deliberately inverting `PLAN-SHELL-TOOL.md`'s L4** —
  git needs `~/.gitconfig`, the credential helper and `ssh` to work at all, and that config is
  operator-authored (which is safe precisely *because* the model can never invoke a subcommand
  that reads it as a command). Everything else is still stripped: a git hook is arbitrary code
  running with this environment, and one `config.test.ts` case (planted `FIRECRAWL_API_KEY` +
  `GITHUB_TOKEN`) is what keeps it that way.
- **`GIT_TERMINAL_PROMPT=0` is not cosmetic** — without it a push with unusable credentials hangs
  on a terminal prompt until the timeout fires.
- **`git log -z` terminates records with NUL** (impossible in a commit object) so record splitting
  is exact; fields are still `%x1f`-separated, which a commit subject could in principle contain.
  `git-history.ts` has the identical latent issue. Accepted, not overlooked.
- **Sanitize after splitting records, never before.** Scrubbing strips control characters and the
  field separators *are* control characters — reversing the order silently collapses every record
  into one.
- **`exec.ts` and `path-safety.ts` live in `plugin-common` and are shared** with
  `PLAN-FILE-TOOL.md` and (if it is ever built) `PLAN-SHELL-TOOL.md`, which now inherits the
  runner rather than authoring it. `detached: true` + `process.kill(-pid)` is load-bearing: git
  spawns `ssh`, credential helpers and hooks, and Node's `timeout` kills only the direct child.
- No parity fixture and no e2e spec, and why (§6.6/§6.7) — tracked gaps.

## 9. Definition of done

- [ ] `pnpm -r typecheck` and `pnpm test` green from the repo root (`plugin-common` is modified).
- [ ] `packages/plugins/git` exists with the tests in §6.1, §6.3 and §6.4, including the
      credential-leak env test, the flag-as-ref test, and the path-escape test — both of the
      latter asserting **no subprocess was spawned**.
- [ ] `exec.ts` exists in `plugin-common` with §6.5's tests, including the descendant-kill test
      with an explicit vitest timeout.
- [ ] With no env set: `/api/plugins/status` shows git as not configured, a graph enabling it shows
      the workflow-dependency banner, and `/run` returns 409.
- [ ] With `GIT_TOOL_ROOT` set: `ro` exposes exactly five tools, `rw` nine, `rw` + push ten —
      verified through `/api/plugins/status` and a prompt node's tool list, not only in unit tests.
- [ ] A real `git_status` → `git_log` → `git_add` → `git_commit` sequence runs end to end through a
      prompt node's tool loop against a scratch repository, verified manually.
- [ ] README documents every `GIT_TOOL_*` variable, states that identity/credentials/remotes are
      configured by the operator outside flowlathe, and says plainly that `GIT_TOOL_MODE=rw` lets a
      model commit and `GIT_TOOL_ALLOW_PUSH=1` lets it publish to a shared remote.
- [ ] `documentation/notes/plugins-and-tools.md` carries the §8 entries, and
      `documentation/notes/toolchain-and-build.md` records the `@flowlathe/path-safety` extraction.
