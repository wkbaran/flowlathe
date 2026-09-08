# PLAN-FILE-TOOL — an `fs` toolset with a rooted path boundary and an explicit access mode

Closes GitHub issue #2 ("Add file access tool — Include path sanitization and mode").

Companion plan: `PLAN-SHELL-TOOL.md` (issue #1). The two share one new primitive and one real
combined threat — see §9. Read both before implementing either.

---

## 1. Problem

A flow can read the web and write flow State, but it cannot read a file. Every realistic local
workflow — summarize this directory of notes, read a CSV a cron job dropped, write a report next
to the input that produced it — currently has no path through flowlathe at all.

Two words in the issue title carry the whole design:

- **path sanitization** — every path a model supplies is untrusted input, and the naive
  implementations (string-prefix comparison, `path.join` without resolution, resolving without
  `realpath`) each have a well-known bypass.
- **mode** — read-only must be a real, structural mode, not a runtime `if`. In `ro`, the write
  tool is *not registered*, so the model is never told it exists.

---

## 2. Facts that shape the design

Verified in this repo before writing anything below:

1. **A "tool" is a `ToolRegistration`** contributed by a package under `packages/plugins/*` and
   wired by one static line in `packages/server/src/index.ts`. No dynamic loading, deliberately.
2. **"Unset env var ⇒ zero tool registrations" is a locked convention.**
   `/api/plugins/status` derives `configured`/`connected` uniformly from whether a toolset has any
   live registrations (CLAUDE.md's PLAN-INTEGRATIONS Phase A note). This is what makes "mode `ro`
   ⇒ don't register `fs_write`" the natural expression of mode rather than a hack.
3. **`sanitizeUntrustedText` is layer 1; `tool-registry.ts`'s 32,000-char cap is layer 2**
   (PLAN-SANITIZATION-BOUNDARY.md). A file's contents are the most untrusted text this repo will
   ever put in a prompt. The layer-2 cap truncates blindly and would corrupt the JSON envelope, so
   layer 1 must bound reads well below it.
4. **A caller that owns its own truncation marker must scrub-then-truncate itself** and must never
   pass a `maxLength` to `sanitizeUntrustedText` — it would slice the marker back off (CLAUDE.md,
   Firecrawl's `[truncated N of M chars]`).
5. **`@flowlathe/core` must stay isomorphic** — no `node:*` anywhere in it, because
   `packages/web`'s `tsc --noEmit` pulls in all of core's *source* transitively and `skipLibCheck`
   does not shield source files. This decides where the path primitive lives (§9.1), and it is the
   most likely mistake in this plan.
6. **flowlathe's own secrets are files on disk.** `credential.key` (resolved by
   `packages/server/src/credential-key.ts` under `FLOWLATHE_DATA_DIR`) and the SQLite DB at
   `FLOWLATHE_DB_PATH` sit next to each other; the DB holds `providers.secretEnc` and
   `plugin_credentials` encrypted with that key. A file tool that can read both has read every
   secret this server holds.
7. **`FLOWLATHE_FLOWS_DIR` is live-watched.** `watchFlowsDir` (`packages/server/src/flow-store.ts`)
   parses and ingests any `.flow` file that appears there. Writing one is not "writing a file" —
   it is registering a flow with the running server.
8. **`ToolInvokeMeta` carries only `{activationKey, signal}`** — no `emit`, no `suspend`. Bounds
   what v1 can offer (§8).

Prior art read before designing: `hermes-agent`'s `agent/file_safety.py` (write denylist by exact
path and by prefix, an approval tier for `~/.ssh/config`, a read denylist covering credential
stores and `.env*` basenames anywhere on disk, and a `HERMES_WRITE_SAFE_ROOT` containment root),
plus `tools/path_security.py` (`validate_within_dir` via resolve-then-`relative_to`, and a cheap
`has_traversal_component` pre-check). This plan takes the structure and the specific denylist
*classes* from it, adapted to flowlathe's own secrets (fact 6) and to a rooted-by-default model
rather than Hermes's whole-filesystem-with-denylist model.

---

## 3. Locked decisions

| # | Decision | Why |
|---|---|---|
| L1 | **A single root is mandatory.** `FLOWLATHE_FS_ROOT` unset ⇒ zero registrations. Every path argument is relative to it; absolute paths and `~` are refused outright. | Rooted-allow beats deny-everything-sensitive. Hermes needs the latter because its terminal tool must reach the whole filesystem; flowlathe has no such requirement, so the default can be the strong one. |
| L2 | **Mode is structural: `FLOWLATHE_FS_MODE` ∈ `off` (default) \| `ro` \| `rw`.** `ro` registers `fs_read`/`fs_list`/`fs_stat` only. `rw` adds `fs_write`. `off` (or unset) registers nothing. | Fact 2. A registered-but-refusing write tool would still be described to the model in `tools`, inviting calls that always fail — the same "silently including a broken tool" problem CLAUDE.md already flags for a configured-but-not-connected plugin. |
| L3 | **Containment is `realpath`-based, not string-based.** Resolve, then `realpathSync` the target (or its nearest existing ancestor, for a create), then require the result to be the root or under `root + sep`. | A symlink inside the root pointing at `/etc` defeats every lexical check. `path.resolve` alone does not read the filesystem. |
| L4 | **A denylist applies *inside* the root too**, by resolved exact path and by basename. | An operator will point the root at a project directory that contains a `.env`, and flowlathe's own data dir could be inside it (fact 6). The root is the boundary; the denylist is what stops the obvious foot-guns within it. |
| L5 | **`fs_write` never creates an executable file** (mode `0o644`) and never follows a symlink at the destination. Writes are atomic (temp file in the same directory + `rename`). | Directly limits §9.2's write-then-execute composition, and a half-written file that another tool reads mid-write is a real failure mode with no upside. |
| L6 | **No delete, no move, no chmod, no mkdir -p beyond a single parent, no recursive anything in v1.** | Every one of them is destructive and none is needed for "read inputs, write an output". Adding one later is cheap; recovering a directory a model removed is not. |
| L7 | **Reads are bounded and text-only.** Byte cap, line-range arguments, and an explicit refusal for binary content rather than dumping it into a prompt. | Facts 3/4. A 4 MB file reaching layer 2 gets blind-truncated into invalid JSON. |
| L8 | **`standalone` is set** (`fsToolsetFromEnv`), so exported scripts can use this toolset. | Config is env-only, exactly like SearXNG/Firecrawl. |
| L9 | **No `file` node kind in this plan.** Toolset only. | Same reasoning as the shell plan's L9: the NodeKind checklist plus a parity stub is separable work. |
| L10 | **`FLOWLATHE_FLOWS_DIR` and the data dir are refused even when they are inside the root** (facts 6/7), with no opt-out env var. | Writing a `.flow` file is self-modification of the running server; reading `credential.key` plus the DB is total secret compromise. Neither has a legitimate use through this tool. |

---

## 4. Files

New:

```
packages/plugins/fs/package.json           # copy a sibling plugin's verbatim
packages/plugins/fs/tsconfig.json
packages/plugins/fs/src/index.ts           # fsToolsetFromEnv / fsConfigFromEnv
packages/plugins/fs/src/config.ts          # env parsing, mode, boot-time root validation
packages/plugins/fs/src/deny.ts            # the inside-the-root denylist (L4/L10)
packages/plugins/fs/src/read.ts            # read/list/stat implementations
packages/plugins/fs/src/write.ts           # atomic write
packages/plugins/fs/src/tools.ts           # ToolSpecs + handlers + createFsToolset
packages/plugins/fs/src/manifest.ts        # FS_MANIFEST
packages/plugins/fs/src/{config,deny,read,write,tools}.test.ts

packages/plugins/_common/src/path-safety.ts        # shared with PLAN-SHELL-TOOL (§9.1)
packages/plugins/_common/src/path-safety.test.ts
```

Modified:

```
packages/plugins/_common/src/index.ts      # export path-safety
packages/server/src/index.ts               # FS_MANIFEST + fsToolsetFromEnv(...)
README.md                                  # Quickstart env docs + the mode/root explanation
CLAUDE.md                                  # §10
```

---

## 5. Implementation

### 5.0 — scaffold

Copy `packages/plugins/searxng/{package.json,tsconfig.json}`, rename to `@flowlathe/plugin-fs`,
keep the pinned `typescript`/`vitest` versions **exactly** (CLAUDE.md's TypeScript-7 entry).
`packages/plugins/*` is already a workspace glob; only `pnpm install` is needed.

### 5.1 — `path-safety.ts` (shared; see §9.1 before writing it)

```ts
export interface PathVerdict {
  ok: boolean;
  /** Present when !ok. Always starts with "Blocked:" (url-safety.ts's convention). */
  reason?: string;
  /** Present when ok — the realpath-resolved absolute path. Use this, never the input. */
  path?: string;
}

/** Resolve a caller-supplied relative path under `root`, or refuse. `root` must already be
 *  realpath'd by the caller (done once at boot). */
export function resolveWithinRoot(root: string, relative: string, opts?: { mustExist?: boolean }): PathVerdict;
```

Checks, in order — the order matters, cheap and unambiguous first:

1. **NUL byte** anywhere ⇒ refuse. Node throws on NUL in a path, but the thrown error is a
   confusing `ERR_INVALID_ARG_VALUE`; refuse it explicitly with a readable reason.
2. **Absolute path or `~` prefix** ⇒ refuse. Arguments are always root-relative (L1). Do not
   silently reinterpret an absolute path as relative — say so, so the model corrects itself.
3. **Lexical `..` component** ⇒ refuse. `path.normalize(relative).split(sep).includes("..")`.
   This is Hermes's `has_traversal_component` pre-check: cheap, and it produces a much clearer
   error than a post-resolution containment failure.
4. `const candidate = path.resolve(root, relative)`.
5. **`realpathSync`** on `candidate`. If it does not exist and `mustExist` is false, walk up to
   the nearest existing ancestor, `realpathSync` that, and re-append the non-existent tail. If no
   ancestor resolves, refuse.
6. **Containment**: the resolved path must equal `root` or start with `root + path.sep`. Compare
   resolved strings — never the raw input, and never with a bare `startsWith` on an unresolved
   path (`/data/roots-evil` starts with `/data/root`; the `+ sep` is what makes it correct).

**Known accepted gap — TOCTOU.** Between step 5 and the eventual `open`, a symlink could be
swapped. Closing it needs `open` with `O_NOFOLLOW` on every component, or an `openat`-style
fd-relative walk, neither of which Node exposes usefully. The attacker must already have write
access to a directory inside the root on a single-user local server. Recorded here and in the
module doc comment, in the same spirit as `url-safety.ts`'s DNS-rebinding note — considered and
declined, not overlooked.

### 5.2 — `config.ts`

```ts
export type FsMode = "ro" | "rw";
export interface FsConfig {
  root: string;            // realpath'd, verified directory
  mode: FsMode;
  maxReadChars: number;    // default 20_000
  maxWriteBytes: number;   // default 1_000_000
  maxListEntries: number;  // default 500
  deniedExact: Set<string>;   // resolved absolute paths (§5.3)
  deniedPrefixes: string[];   // resolved absolute dirs, each ending in path.sep
}
export function fsConfigFromEnv(env = process.env): FsConfig | undefined;
```

Returns `undefined` — zero registrations — when `FLOWLATHE_FS_ROOT` is unset, does not exist, or
is not a directory after `realpathSync`; or when `FLOWLATHE_FS_MODE` is unset/`off`/unrecognized.
An unrecognized mode is a `console.warn` + `undefined`, never a silent fallback to `rw`.

All of this is boot-time. There is **no I/O in `unavailableReason()`** — `findMissingToolsets`
runs on every `/run`, `/step-start` and every `GraphEngine` construction including step-mode
restores. SearXNG needs `CachedLivenessProbe` because its check is a network round trip; here the
config is either valid at boot or the toolset does not exist, so `unavailableReason` is simply
never set.

### 5.3 — `deny.ts`: the denylist inside the root (L4/L10)

Built once, at boot, from the same environment the server itself reads — so it tracks an
operator's actual configuration instead of guessing at default paths:

**Exact paths (resolved, then compared exactly):**

- `FLOWLATHE_DB_PATH` and its `-wal` / `-shm` siblings
- `<FLOWLATHE_DATA_DIR>/credential.key` (mirror `credential-key.ts`'s own resolution — import its
  helper if it exports one rather than re-deriving the path)

**Prefixes (resolved directory + `path.sep`):**

- `FLOWLATHE_DATA_DIR`
- `FLOWLATHE_FLOWS_DIR` — read **and** write. Read is denied for consistency and because a flow's
  source text is not interesting model context; write is denied because the watcher would ingest
  it (fact 7).
- `.git/` anywhere under the root — `.git/config` carries `url = https://user:token@…`, and
  writing `.git/hooks/*` is a code-execution path the next `git` invocation takes.

**Basenames, denied anywhere under the root** (Hermes's `_BLOCKED_PROJECT_ENV_BASENAMES`,
adapted):

```
.env  .env.local  .env.development  .env.production  .env.test  .env.staging  .envrc
.git-credentials  .netrc  .pgpass  .npmrc  .pypirc
id_rsa  id_ed25519  id_ecdsa  authorized_keys
```

Error text for a denylist hit should follow Hermes's example and be *useful*: for `.env`, say
that `.env.example` is the documented-shape substitute. A model that gets a reason acts on it; a
model that gets "denied" retries.

`isDenied(cfg, resolvedPath): string | undefined` returns the reason, and is called **after**
`resolveWithinRoot` (so it always sees a realpath'd absolute path) and **before** any open.

### 5.4 — `read.ts`

`fs_read(pathArg, {offset?, limit?})`:

1. `resolveWithinRoot(cfg.root, pathArg, {mustExist: true})` ⇒ `toolFail(reason)` on refusal.
2. `isDenied` ⇒ `toolFail(reason)`.
3. `statSync` — a directory gets a pointed error naming `fs_list`; anything that is not a regular
   file (fifo, socket, device) is refused, since opening one can block forever.
4. Read at most `maxWriteBytes`-ish worth of bytes (a byte cap independent of the char cap, so a
   huge file is never fully buffered), honoring `meta.signal` via `fs/promises.readFile`'s
   `signal` option.
5. **Binary detection**: a NUL byte in the first 8 KB, or a failed strict UTF-8 decode
   (`new TextDecoder("utf-8", {fatal: true})`). Refuse with "appears to be binary" — do **not**
   base64 it into a prompt.
6. `offset`/`limit` are **line** numbers (1-based offset, count limit), matching what a model
   already expects from file-reading tools and making "read the next chunk" expressible after a
   truncation.
7. **Truncate with a marker, scrub-then-slice** (fact 4): `scrubUntrustedText(text, "fs_read")`,
   then slice to `cfg.maxReadChars`, then append `[truncated N of M chars]`. Never
   `sanitizeUntrustedText(text, maxLength)` here.
8. `toolOk({path, lines, totalLines, truncated, content})`.

`fs_list(pathArg, {})`: entries as `{name, type: "file"|"dir"|"other", size, mtime}`, capped at
`cfg.maxListEntries` with a `truncated` flag, non-recursive, denylisted entries omitted (not
errored — a directory containing a `.env` should still list). Sanitize each `name`: a filename is
attacker-controlled text reaching a prompt, and a file named with bidi isolates is a real trick.

`fs_stat(pathArg)`: `{type, size, mtime}`. Cheap, and it lets a model check size before reading —
worth the third tool.

### 5.5 — `write.ts` (mode `rw` only)

`fs_write(pathArg, content, {mode?: "create"|"overwrite"|"append"})`:

1. `resolveWithinRoot(cfg.root, pathArg, {mustExist: false})`, then `isDenied`.
2. The **parent directory must already exist and must itself resolve inside the root**. Create at
   most nothing — no `mkdir -p` (L6). A missing parent is an error naming the parent.
3. **`lstatSync` the destination**: if it exists and is a symlink, refuse outright (L5) — do not
   follow it even when its target is inside the root, because that is indistinguishable to the
   model from writing the file it named.
4. Default `mode` is `"create"`: an existing destination is refused unless the caller passes
   `"overwrite"` explicitly. Making destruction opt-in is worth one extra round trip.
5. Byte cap: reject content over `cfg.maxWriteBytes` before touching the disk.
6. **Atomic write**: write to `<dir>/.flowlathe-fs-<random>.tmp`, `fsync`, `rename` into place,
   `unlink` the temp on any failure. `rename` within a directory is atomic on POSIX; a temp file
   in `/tmp` would not be (cross-device `rename` fails with `EXDEV`). For `"append"`, an atomic
   rename is not possible — use a plain append with the `"a"` flag and say so in the doc comment.
7. Explicit `mode: 0o644` on create (L5).
8. `toolOk({path, bytesWritten, mode})`.

### 5.6 — `tools.ts`: specs, handlers, toolset

Four `ToolSpec`s (`fs_read`, `fs_list`, `fs_stat`, `fs_write`), all with `toolset: "fs"`. Each
description must state that paths are **relative to a fixed root** and that absolute paths are
refused — otherwise a local model will emit `/home/…` on every call, and the error text is the
only teacher it has.

```ts
export function createFsToolset(cfg: FsConfig): ToolRegistration[] {
  const regs = [readReg(cfg), listReg(cfg), statReg(cfg)];
  return cfg.mode === "rw" ? [...regs, writeReg(cfg)] : regs;   // L2, the whole point
}
```

Handlers follow the house pattern exactly: `requireString` inside a try/catch returning
`toolFail` for `PluginArgError`; `guarded("fs", "<kind>", …)` around the I/O so an unexpected
throw lands in the same one-line taxonomy every other plugin produces; `toolOk`/`toolFail` for
the envelope, `ok` first. No `trustedResult` — ever; that field is whitelisted to the built-in
state tools.

`standalone`: `{module: "@flowlathe/plugin-fs", factory: "fsToolsetFromEnv", env: ["FLOWLATHE_FS_ROOT", "FLOWLATHE_FS_MODE", …]}`, the identical object spread onto every registration (CLAUDE.md's
note that `compileGraph` partitions by `.find()`, so a toolset must not have some registrations
carrying `standalone` and others not).

### 5.7 — manifest and server wiring

`FS_MANIFEST`: `toolset: "fs"`, `displayName: "Files"`, a description naming the root and mode, an
`env` entry per variable, no `connect`. Then in `packages/server/src/index.ts`:

```ts
const pluginManifests: PluginManifest[] = [..., FS_MANIFEST];
pluginToolsets = [...pluginToolsets, ...fsToolsetFromEnv()];
```

Everything downstream is manifest-driven and needs no edits: `/api/plugins/status`, the per-node
toolset checkbox in `Canvas.tsx`, `requiredToolsets(graph)`, the workflow-dependency banner, and
the `/run` + `/step-start` 409 gates. Verify, don't assume.

---

## 6. Testing

`vitest`, colocated, real filesystem under `mkdtempSync(join(tmpdir(), …))` — no `fs` mocking.
Mocking `node:fs` here would test the mock, and every bug this plan is about lives in the real
resolution semantics.

### 6.1 `path-safety.test.ts` — the load-bearing suite

- `..` in the middle (`a/../../etc/passwd`) and at the start
- an absolute path, a `~/…` path
- a NUL byte
- **the sibling-prefix bypass**: root `/tmp/x/root`, target `/tmp/x/root-evil` ⇒ refused (this is
  the test that pins the `+ path.sep` in the containment check)
- **a symlink inside the root pointing outside it** ⇒ refused. Create it for real with
  `symlinkSync`. This is the single most important test in the plan.
- a symlink inside the root pointing *inside* it ⇒ allowed, and `verdict.path` is the realpath'd
  target, not the link
- a not-yet-existing file whose parent exists ⇒ allowed with `mustExist: false`
- a not-yet-existing file whose parent is a symlink out of the root ⇒ refused
- the root itself (`""`, `"."`) ⇒ allowed
- **a root that is itself a symlink** (`/tmp/link -> /tmp/real`): since the caller realpaths the
  root at boot, containment must still hold for paths under it — assert it does, because the
  macOS `/tmp -> /private/tmp` case makes this fire on a real developer machine, not just in
  theory

### 6.2 `deny.test.ts`

- `.env` inside the root ⇒ refused for read and for write, with the `.env.example` hint
- `.git/config` ⇒ refused
- `FLOWLATHE_DB_PATH` placed inside the root ⇒ refused (build the config with the env var
  actually pointing there)
- `FLOWLATHE_FLOWS_DIR` inside the root ⇒ refused both ways (L10)
- a file merely *named* like a denied basename in a subdirectory ⇒ still refused (basename rule
  applies at any depth)
- `fs_list` of a directory containing a denied file ⇒ succeeds, entry omitted, no error

### 6.3 `read.test.ts` / `write.test.ts`

- a UTF-8 file round-trips; a file with a NUL byte is refused as binary; a file with invalid
  UTF-8 is refused
- a file over `maxReadChars` comes back with the marker **last** in the string (proving
  scrub-then-truncate, not `sanitizeUntrustedText(…, maxLength)`), and `truncated: true`
- a file whose content contains zero-width/tag characters comes back scrubbed
- line `offset`/`limit` select the right lines, and an out-of-range offset is a clean empty result
- a directory passed to `fs_read` errors naming `fs_list`
- `meta.signal` aborted mid-read settles promptly
- write: `create` refuses an existing file; `overwrite` replaces it; `append` appends
- write: destination is a symlink ⇒ refused (create it for real)
- write: missing parent ⇒ refused, naming the parent
- write: over `maxWriteBytes` ⇒ refused **without** having created a temp file (assert the
  directory is clean afterwards)
- write: resulting file mode is `0o644` and no `.tmp` file is left behind, on success **and**
  after a forced mid-write failure

### 6.4 `tools.test.ts`

- `fsToolsetFromEnv({})` ⇒ `[]`; root set but mode unset ⇒ `[]`; mode `garbage` ⇒ `[]` + warn
- **mode `ro` ⇒ exactly three registrations and `fs_write` is absent from
  `registry.specsFor(["fs"])`** — the structural expression of L2, and the one behavior a future
  refactor is most likely to quietly convert into a runtime check
- mode `rw` ⇒ four
- every registration carries the same `standalone` object identity

### 6.5 Parity and e2e

**No golden parity fixture.** The parity harness stubs the mock provider and outbound HTTP; it
has no filesystem stub, and a fixture touching a real temp directory would make the harness
environment-dependent for the first time. An `fs` *node kind* (L9, deferred) would need one, in
the `(nodeId, sha256(args))`-keyed shape PLAN-INTEGRATIONS.md's design trap 8 describes.

**No Playwright spec**, consistent with every plugin-shaped slice in this repo (CLAUDE.md records
that Spotify, Gate, MCP, SearXNG, Firecrawl and Discord all have none, and that the first plugin
e2e spec is separable work). Coverage is the unit suite plus a manual smoke test: point the root
at a scratch directory, run a flow that reads a file and writes a summary next to it, and confirm
the dependency banner + 409 gate behave with the env unset.

---

## 7. Ordering

1. `path-safety.ts` + §6.1 tests. Nothing else starts until the symlink and sibling-prefix cases
   pass — everything below is a thin wrapper over this.
2. Package scaffold, `config.ts`, `deny.ts` + tests.
3. `read.ts` (mode `ro` end to end, registered, smoke-tested).
4. `write.ts` and mode `rw`.
5. Server wiring, README, CLAUDE.md.

Step 1 is shared with `PLAN-SHELL-TOOL.md` (§9.1) and is the only step touching existing packages.

---

## 8. Scope: deliberately not built

- **Delete / move / chmod / recursive listing / `mkdir -p`** (L6).
- **Glob or search** (`fs_grep`). Genuinely useful, and a separate design problem (bounding a
  recursive walk, ordering results, denylist interaction at every level). If it lands, it must
  reuse `resolveWithinRoot` per candidate, not walk with its own containment logic.
- **Multiple roots.** One root, one mode. Hermes's `HERMES_WRITE_SAFE_ROOT` is `os.pathsep`-split
  and multi-valued; that generality is only worth it once someone asks.
- **Per-path approval tiers.** Hermes gates `~/.ssh/config` behind a human prompt rather than a
  hard deny. flowlathe cannot express this today: a tool handler cannot reach `host.suspend`
  (fact 8), even though `packages/nodes/pause`, `createSuspendRegistry` and
  `POST /api/executions/:id/resume` already implement every other part. Adding
  `ToolInvokeMeta.requestApproval?: (summary) => Promise<boolean>` would enable it here *and* for
  the shell tool with no new UI concepts — the same one-field change both plans defer.
- **An audit trail.** Tool handlers have no `emit`, so file access does not appear in the run log.
  Same deferral; `console.log`-prefixed `[fs]` lines at the server are the v1 substitute.
- **A `file` node kind** (L9).
- **Windows path semantics** (drive letters, UNC, `\\?\`, case-insensitive containment). The repo
  targets WSL2/Linux and an Alpine container; `resolveWithinRoot`'s containment comparison is
  case-sensitive and would need real thought on a case-insensitive filesystem. State the
  limitation rather than half-supporting it — note that macOS's default case-insensitive
  filesystem means the comparison is technically already loose there, which is a bypass only for
  a *denylist* entry (`.ENV`), not for the root containment, since both sides come from the same
  `realpathSync` output.

---

## 9. Shared with `PLAN-SHELL-TOOL.md`

### 9.1 One path primitive, owned by whichever plan lands first

`resolveWithinRoot` (§5.1) is specified identically in both plans and must exist exactly once, at
`packages/plugins/_common/src/path-safety.ts`. The shell tool uses it for its optional per-call
`workdir`; this plugin uses it for every path argument.

**It cannot live in `@flowlathe/core`** (fact 5): `realpathSync` is `node:fs`, and core is pulled
into `packages/web`'s typecheck as *source*. `@flowlathe/plugin-common` is Node-only by
construction and is already a dependency of both plugins. If a future *node kind* ever needs it,
move it to a new Node-only shared package rather than into core — `@flowlathe/runtime` imports
every `@flowlathe/node-*` package, so a node kind importing `plugin-common` would drag a plugin
helper library into runtime's transitive closure.

### 9.2 The combined threat: write-then-execute

Landing both issues creates a capability neither has alone. If `FLOWLATHE_FS_MODE=rw` and
`FLOWLATHE_FS_ROOT` overlaps `SHELL_TOOL_WORKDIR`, a model can write a file and then run it. What
each plan contributes:

- **here**: `fs_write` creates mode `0o644`, never executable, never through a symlink (L5)
- **shell**: a command must be a bare name resolved through a `PATH` the plugin builds, which must
  never include the fs root — so a written file can neither be named directly nor shadow an
  allowlisted name
- **residual, documented, not fixed**: an operator who allowlists an interpreter (`node`,
  `python3`, `bash`) *and* enables `rw` on an overlapping root has composed "write a script, run
  the interpreter on it". Passing a file path to an interpreter is its normal use; no flag table
  addresses it. README must say this in the same paragraph that introduces both env vars.

---

## 10. `CLAUDE.md` notes (definition of done)

Add one entry, in this file's established voice — the surprises, not the summary:

- **`path-safety.ts` lives in `@flowlathe/plugin-common`, not `@flowlathe/core`, and that is
  deliberate**: `realpathSync` is `node:*`, and core is pulled into `packages/web`'s typecheck as
  source, where `skipLibCheck` does not shield it (the `Buffer`-in-`BlobStore` lesson, again). The
  `url-safety.ts`/`plugin-deps.ts` precedent of "shared primitive ⇒ core" does **not** generalize
  to primitives that touch the filesystem.
- **Containment is `realpath`-then-`startsWith(root + sep)`.** Both halves are load-bearing: the
  realpath closes symlink escape, and the `+ sep` closes `/data/root-evil` vs `/data/root`. Pinned
  by tests that create real symlinks.
- **TOCTOU is a known, accepted gap** (a symlink swapped between the check and the open), for the
  same reason `url-safety.ts` accepts DNS rebinding — recorded so the next audit does not re-file
  it as new.
- **Mode `ro` means `fs_write` is never registered**, not "registered and refusing" — the model is
  never told a write tool exists. Reverting this to a runtime `if` would silently reintroduce the
  "broken tool in the prompt's context" problem CLAUDE.md already flags for configured-but-not-
  connected plugins.
- **flowlathe's own secrets and its live-watched flows directory are denied even inside the root**
  (`credential.key` + the SQLite DB it decrypts; `FLOWLATHE_FLOWS_DIR`, where a written `.flow`
  file is not a file but a flow registered with the running server via `watchFlowsDir`). No opt-out.
- Reads are truncated with their own `[truncated N of M chars]` marker, so they use
  `scrubUntrustedText` + a manual slice, never `sanitizeUntrustedText(…, maxLength)` (which would
  cut the marker off) — and the cap is set well below `tool-registry.ts`'s 32,000-char layer-2
  backstop so that backstop never fires and corrupts the JSON envelope.
- `fs_list` sanitizes **filenames**, not just contents — a filename is attacker-controlled text
  reaching a prompt.
- No parity fixture and no e2e spec, and why (§6.5) — tracked gaps.
- The approval-tier and audit-event deferrals, naming `ToolInvokeMeta` as the one field-width
  change either would need (§8) — shared with the shell plan.

## 11. Definition of done

- [ ] `pnpm -r typecheck` and `pnpm test` green from the repo root.
- [ ] `packages/plugins/fs` exists with the suites in §6.1–§6.4, including the real-symlink escape
      test and the sibling-prefix test.
- [ ] Mode `ro` provably does not register `fs_write` (asserted through `specsFor`, not by
      reading the source).
- [ ] With no env set: `/api/plugins/status` shows files as not configured, a graph enabling the
      toolset shows the workflow-dependency banner, and `/run` returns 409.
- [ ] With env set: a flow reads a file and writes a summary beside it, verified manually against
      the running server.
- [ ] README documents `FLOWLATHE_FS_ROOT` / `FLOWLATHE_FS_MODE`, the denylist and why
      flowlathe's own data and flows directories are in it, and the write-then-execute interaction
      of §9.2.
- [ ] CLAUDE.md carries the §10 entry.
