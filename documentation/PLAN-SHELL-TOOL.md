# PLAN-SHELL-TOOL — a `shell` toolset a model can run local commands through

Closes GitHub issue #1 ("Add shell tool — Including sanitization and sandboxing").

> **Status: deferred behind the domain toolsets, and amended.** `PLAN-DOMAIN-TOOLS.md` found that
> this plan's actual boundary — the command allowlist — fails outright for the two commands an
> operator is most likely to reach for: `git config core.pager …` then `git log`, and
> `aws configure set credential_process …` then any `aws` call, are each arbitrary code execution
> in **two allowlisted calls**, with no blocked flag used and no interpreter allowlisted. Both are
> now hard-refused by L11 below. `git` and GitHub are built as domain plugins instead
> (`PLAN-GIT.md`, `PLAN-GITHUB.md`); AWS gets no toolset at all, because IAM is a strictly better
> boundary than any argv filter (`PLAN-DOMAIN-TOOLS.md` D3).
>
> This plan is **not cancelled** — it remains the only answer to the genuinely open-ended case
> (run a test suite, invoke `ffmpeg`, call a CLI with no API). Build it last, and treat
> `SHELL_TOOL_WRAPPER` (§7.3) as required rather than optional when you do.

Companion plans: `PLAN-DOMAIN-TOOLS.md` (read first — the amendments above and their reasoning),
`PLAN-FILE-TOOL.md` (issue #2). This plan and the file tool share one new primitive and one real
combined threat — see §9. Read all three before implementing this one.

---

## 1. Problem

flowlathe can search the web, scrape pages, talk to Discord and Spotify, and call an arbitrary
MCP server's tools — but it cannot run a local command. Every tool a prompt node can reach today
is a network call to a vendor. A flow that wants to run a test suite, resize an image with
`ffmpeg`, or call a CLI that has no HTTP API has no path at all.

(This list originally offered `git` as its lead example. It is no longer here: `git` turned out to
be one of the commands this design specifically *cannot* make safe — see the status banner above
and L11 — and is built as `PLAN-GIT.md` instead. That correction is the reason
`PLAN-DOMAIN-TOOLS.md` exists.)

This is the single sharpest surface anything in this repo will ever add: a local model's tool
arguments become a process on the operator's machine, running as the operator's user, with the
operator's environment — which, in this server's process, includes `FIRECRAWL_API_KEY`,
`DISCORD_BOT_TOKEN`, `SPOTIFY_CLIENT_ID` and the path to `credential.key`. The plan is
correspondingly conservative and states, explicitly, what it does *not* protect against.

### 1.1 Facts that shape the design

Established, verified in this repo before writing anything below:

1. **A "tool" here means a `ToolRegistration`** (`packages/core/src/contracts.ts`): a
   `{toolset, spec, handler}` triple contributed by a plugin package under `packages/plugins/*`,
   registered by one static line in `packages/server/src/index.ts`. No dynamic loading exists,
   deliberately (CLAUDE.md's MCP/Spotify notes).
2. **`packages/plugins/mcp/src/security.ts` already solves half of this problem.** It exists
   because the MCP stdio transport spawns a local subprocess, and it already implements: a
   command allowlist with a secure default (`MCP_ALLOWED_COMMANDS` unset ⇒ nothing runs), a
   per-command dangerous-flag table (`node -e`, `npx -c`, `python -c`, `docker run …`), a
   shell-metacharacter/chaining rejection over args, a no-`cwd`-override rule, and a null-byte
   check on env values. It is currently private to the MCP plugin and validates an
   *operator-authored config file*. This plan generalizes it and points it at *model-authored
   arguments*, which is a strictly stronger threat model.
3. **`packages/server/src/git-history.ts` already learned the argv lesson the hard way.** Per
   CLAUDE.md's HANDOFF-QUICK-FIXES notes, `git show <sha>:<path>` was vulnerable to *argument*
   injection (a `sha` beginning with `-` is parsed by git as an option) even though `execFileSync`
   already made *shell* injection impossible. Blocking shell metacharacters is not the same as
   blocking a leading dash.
4. **Tool results are already sanitized at two layers** (PLAN-SANITIZATION-BOUNDARY.md): per-field
   at the source, plus a 32,000-char whole-result backstop in
   `packages/runtime/src/tool-registry.ts`. A command's stdout is textbook untrusted text — it may
   literally be `cat someone-elses-file` — so layer 1 is mandatory here, and the layer-2 cap
   constrains how large a result may be before it corrupts its own JSON envelope.
5. **"Unset env var ⇒ zero tool registrations" is a locked, load-bearing convention.**
   `/api/plugins/status` derives `configured`/`connected` uniformly from whether a toolset has any
   live registrations (CLAUDE.md's PLAN-INTEGRATIONS Phase A note); a plugin that registers
   unconditionally and always fails `unavailableReason()` would silently read as "configured".
6. **`ToolInvokeMeta` carries only `{activationKey, signal}`.** A tool handler cannot emit a
   `RunEvent`, cannot reach `host.suspend`, and therefore cannot ask a human for approval or write
   an audit line into the run log. This bounds what v1 can offer (§7, §8).
7. **The Docker image is the only isolation this repo has today**, and it is real: `USER node`,
   a defined filesystem, `-p 127.0.0.1:…` documented in README §"Deployment and network posture".

---

## 2. Locked decisions

| # | Decision | Why |
|---|---|---|
| L1 | **No shell. Ever.** `execFile` with an argv array; `shell` is never set. The model supplies `command` (a bare name) and `args` (an array of strings). | Pipes, redirection, globs, `&&`, `$(…)` and backticks stop being a filtering problem and become structurally unrepresentable. This is why the plan can be short: most of what a shell-tool CVE list contains simply has no encoding here. |
| L2 | **Allowlist by bare command name, secure default empty.** `SHELL_TOOL_ALLOWED_COMMANDS` unset or empty ⇒ zero registrations ⇒ the model is never told the tool exists. | Mirrors `MCP_ALLOWED_COMMANDS` / `SPOTIFY_CLIENT_ID` exactly (fact 5). An operator opts in per command, not per feature. |
| L3 | **A command must be a bare name resolved through a locked `PATH`** — no `/`, no `\`, no `.`-relative form, never an absolute path. | An absolute path trivially sidesteps a name-based allowlist (`/tmp/npx`). Resolution happens through a `PATH` this plugin sets, not one the model or a passthrough env var can influence. |
| L4 | **The child's environment is built, never inherited.** `PATH`, `HOME`, `LANG`, `TZ` only, plus names the operator explicitly lists in `SHELL_TOOL_ENV_PASSTHROUGH`. | The server process holds every plugin credential in `process.env`. `spawn`'s default is to inherit all of it. A model that can run `printenv` in an inheriting child has exfiltrated every API key in one call — no traversal, no exploit, just the default. |
| L5 | **One fixed root: `SHELL_TOOL_WORKDIR`, required, `realpath`-resolved at boot.** An optional per-call `workdir` argument is resolved *under* that root through the shared path-safety primitive (§9); anything else is refused. | The MCP config validator already refuses a `cwd` outright. A model-relative subdirectory is genuinely useful (run tests in one package) and is safe once containment is enforced by the same code the file tool uses. |
| L6 | **Sandboxing is offered as an operator-supplied argv prefix (`SHELL_TOOL_WRAPPER`), not as a home-grown seccomp/namespace implementation.** | Shipping a half-real sandbox that *looks* like a boundary is worse than documenting an honest one. `bwrap`, `firejail`, `nsjail`, `sandbox-exec` and `systemd-run` all take this shape and the operator picks. The container remains the recommended isolation (§7). |
| L7 | **Non-zero exit is a *successful* tool call**, returned as `toolFail`-shaped data with `exitCode`/`stdout`/`stderr` — not a thrown error. | A model needs to read a compiler's error output. A failed command is information, not a plugin failure. `toolFail` is reserved for "the tool could not run the command at all" (not allowlisted, timed out, workdir escape). |
| L8 | **`standalone` is set** (`shellToolsetFromEnv`), so an exported compiled script can use this toolset. | Config is env-only, exactly like SearXNG/Firecrawl. An operator who set the env vars on the machine running the script opted in there too. Documented in README with the same warning as the server. |
| L9 | **No `shell` node kind in this plan.** Toolset only. | Phase C's `search`/`fetch` node kinds are a separable pattern (`accessorExpr`, port names, DSL, Canvas views, golden fixtures). Deferred deliberately — §8. |
| L10 | **Linux/macOS only.** No Windows support, no `cmd.exe`/PowerShell path. | The repo targets WSL2/Linux and an Alpine container; a Windows argv-quoting story is a second, differently-shaped problem (`CreateProcess` re-parses the command line) and there is no consumer for it. |
| L11 | **A command whose own config file can name a command to execute is hard-refused, regardless of the allowlist** — `git`, `aws`, `gh`, `npm`, `pnpm`, `yarn`, `docker`, alongside the `sudo`/`doas`/`su` refusal already in §4.1 step 2. An operator cannot opt in via `SHELL_TOOL_ALLOWED_COMMANDS`. | Added by `PLAN-DOMAIN-TOOLS.md` §1. Writing that config is *itself* an allowlisted invocation, so the pair "write the config, then run anything" is arbitrary execution in two calls with no blocked flag and no interpreter allowlisted. The flag table cannot see it because no flag is involved, and `HOME = workdir` (L4) is what makes the written config persist between the two calls (§7.1). This is a different mechanism from L2's allowlist and needs its own refusal. |

---

## 3. Files

New:

```
packages/plugins/shell/package.json          # copy a sibling plugin's verbatim (see §4.0)
packages/plugins/shell/tsconfig.json
packages/plugins/shell/src/index.ts          # shellToolsetFromEnv / shellConfigFromEnv
packages/plugins/shell/src/config.ts         # env parsing + boot-time validation
packages/plugins/shell/src/exec.ts           # the one execFile call and its bounds
packages/plugins/shell/src/tools.ts          # ToolSpec + handler + createShellToolset
packages/plugins/shell/src/manifest.ts       # SHELL_MANIFEST
packages/plugins/shell/src/config.test.ts
packages/plugins/shell/src/exec.test.ts      # real subprocesses, no mocking
packages/plugins/shell/src/tools.test.ts

packages/plugins/_common/src/command-safety.ts       # promoted from plugin-mcp (§4.1)
packages/plugins/_common/src/command-safety.test.ts
packages/plugins/_common/src/path-safety.ts          # shared with PLAN-FILE-TOOL (§9)
packages/plugins/_common/src/path-safety.test.ts
```

Modified:

```
packages/plugins/_common/src/index.ts        # export the two new modules
packages/plugins/mcp/src/security.ts         # delegate to command-safety, keep McpConfigError
                                             # (package.json already depends on plugin-common)
packages/server/src/index.ts                 # SHELL_MANIFEST + shellToolsetFromEnv()
README.md                                    # Quickstart env docs + a posture paragraph
CLAUDE.md                                    # the surprises this lands (§10)
Dockerfile                                   # comment only — see §7.2
```

---

## 4. Implementation

### 4.0 — scaffold the package

Copy `packages/plugins/searxng/{package.json,tsconfig.json}` and change the name to
`@flowlathe/plugin-shell`. Keep the dependency set (`@flowlathe/core`,
`@flowlathe/plugin-common`) and the pinned `typescript`/`vitest` versions **exactly** as the
sibling has them — do not resolve `latest` for either (CLAUDE.md's TypeScript-7 entry).
`packages/plugins/*` is already a workspace glob, so only `pnpm install` is needed.

### 4.1 — promote the command-safety checks out of `plugin-mcp`

Move the guts of `packages/plugins/mcp/src/security.ts` into
`packages/plugins/_common/src/command-safety.ts`, exporting:

```ts
export class CommandSafetyError extends Error {}

export function parseAllowlist(csv: string | undefined): Set<string>;

/** Throws CommandSafetyError unless `command` is an allowlisted bare name and every entry of
 *  `args` is safe to hand to execFile as argv. */
export function validateCommandInvocation(
  command: string,
  args: readonly string[],
  allowed: ReadonlySet<string>,
): void;
```

`validateCommandInvocation` runs, in order:

1. **Bare-name check (new, L3).** Reject a `command` containing `/`, `\`, or a NUL; reject `.`
   and `..`; reject an empty string. The MCP validator never needed this because an operator
   writing a config file naming an absolute path was doing so deliberately.
2. **Allowlist membership.** Unchanged from the MCP version, with the error naming the current
   allowlist so an operator sees what they'd have to add.
3. **Per-arg injection scan.** The existing `SHELL_METACHARACTERS` / `COMMAND_CHAINING` regexes.
   Under `execFile` these are not *directly* exploitable (there is no shell to interpret them) —
   the existing doc comment says exactly this and stays true. Keep them anyway: an argument
   containing `; rm -rf /` is either a model that has misunderstood the tool (worth an explicit
   error) or a command that will itself re-invoke a shell.
4. **The leading-dash class (fact 3) — analyzed, and deliberately no separate check.**
   `git-history.ts`'s bug existed because a *value* (a caller-supplied sha) was interpolated into
   an argv slot where git would also accept an option: there was a template/value boundary, and
   a `-`-prefixed value crossed it. This tool has no such boundary — every argv element is
   supplied deliberately by the caller, so "a value was mistaken for a flag" is not a reachable
   shape. Do **not** add a blanket "no arg may start with `-`" rule: it would break `ls -la` and
   buy nothing. The control for "a flag turned an allowlisted command into arbitrary execution"
   is step 5, and only step 5. Record this reasoning in the module doc comment so the next audit
   does not re-file it.
5. **Dangerous-flag table.** The existing `DANGEROUS_FLAGS_BY_COMMAND` (including its combined
   short-flag expansion, `-yc` ⇒ `-y` + `-c`), extended with the entries a model-facing tool
   needs that an operator-written MCP config did not:

   ```
   sh, bash, zsh, dash, ash : -c, -s, -o   (any of these re-open the shell L1 closed)
   env                      : -S, --split-string, -i   (env VAR=x cmd is a command launcher)
   perl, ruby               : -e, -E, -n, -p
   awk, gawk                : -f (script file), and awk's first positional IS a program — see below
   find                     : -exec, -execdir, -delete, -fprintf, -fls
   xargs                    : -I, -i, --replace, -a
   git                      : -c, --exec-path, --upload-pack, --receive-pack
   ssh, scp, rsync          : -o, -e, --rsh
   sudo, doas, su           : (never allowlistable — hard-refuse the command name itself)
   ```

   `sudo`/`doas`/`su` are refused at step 2 regardless of the allowlist: an operator who puts
   them in `SHELL_TOOL_ALLOWED_COMMANDS` has almost certainly not thought it through, and the
   cost of being wrong is total. Since L11, they are joined there by `git`, `aws`, `gh`, `npm`,
   `pnpm`, `yarn` and `docker` — a single `HARD_REFUSED_COMMANDS` set, checked before the
   allowlist, with an error message naming the reason (`"<cmd> can write a config file naming a
   command to execute; see PLAN-DOMAIN-TOOLS.md"`) rather than just "not allowed", so an operator
   who tries does not simply add it to the allowlist and move on. Document this as the one place
   the allowlist is overridden.

   The flag table has **three** honest limits, not one, and the module doc comment must name all
   three:

   - **`awk`'s first positional argument is a program.** `awk 'BEGIN{system("…")}'` needs no flag
     at all. The same is true of `find … -exec` (in the table) and of any interpreter an operator
     allowlists.
   - **A subcommand is not a flag.** `docker run` was already in the table as a subcommand — the
     one place this mechanism is reached for — and that is the exception rather than the rule.
     `git config`, `aws configure`, `npm config` are all subcommands, invisible to a flag scan.
   - **A config file is not an argument.** L11's class: the dangerous invocation and the harmless
     one are two separate calls, so no single-call check can see the pair. This is the limit that
     `PLAN-DOMAIN-TOOLS.md` §1 found and that L11 exists for.

   **The flag table catches known shapes; the allowlist is the actual boundary** — and L11 exists
   because for one class of command that boundary is unsound at any setting. An operator
   allowlisting an interpreter has granted arbitrary execution and no table will un-grant it.
6. **Env-value null-byte check.** Unchanged.

`packages/plugins/mcp/src/security.ts` keeps `McpConfigError` and
`validateStdioServerConfig` as a thin wrapper: it still refuses `cwd`, then calls
`validateCommandInvocation` and re-throws `CommandSafetyError` as `McpConfigError` so its own
tests and error strings are unaffected. `packages/plugins/mcp/src/security.test.ts` already exists
and must pass **unmodified** — treat any need to edit it as a signal that the delegation changed
behavior rather than moved it. If an assertion depends on an exact message, change the message in
`command-safety.ts` rather than forking the check.

### 4.2 — `config.ts`: parse and validate once, at boot

```ts
export interface ShellConfig {
  workdir: string;              // realpath'd, verified to be an existing directory
  allowed: ReadonlySet<string>;
  env: Record<string, string>;  // the fully-built child env (L4)
  wrapper: string[];            // argv prefix, [] when unset (L6)
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  maxOutputChars: number;
}

export function shellConfigFromEnv(env = process.env): ShellConfig | undefined;
```

Returns `undefined` — meaning zero registrations — when any of these holds:

- `SHELL_TOOL_ALLOWED_COMMANDS` is unset/empty (L2),
- `SHELL_TOOL_WORKDIR` is unset, does not exist, or is not a directory after `realpathSync`,
- `SHELL_TOOL_WRAPPER` is set but its first token isn't itself resolvable.

Log one `console.warn` line per rejected reason at boot. This is the *only* filesystem I/O in
the whole plugin outside a tool call: `findMissingToolsets` runs on every `GraphEngine`
construction, including every step-mode restore, so `unavailableReason()` must never stat
anything (contrast SearXNG's `CachedLivenessProbe`, which exists precisely because its check
*is* I/O). Here there is nothing to probe: config is either valid at boot or the toolset does
not exist, and `unavailableReason` is simply never set.

Environment construction (L4):

```
PATH   = SHELL_TOOL_PATH ?? "/usr/local/bin:/usr/bin:/bin"     // never process.env.PATH
HOME   = the resolved workdir                                   // not the operator's $HOME
LANG   = "C.UTF-8"
TZ     = process.env.TZ ?? "UTC"
+ each name in SHELL_TOOL_ENV_PASSTHROUGH (comma-separated), copied from process.env if present
```

`PATH` is deliberately not inherited: an inherited `PATH` with a writable directory on it turns
the bare-name allowlist (L3) into "run whatever is named `git` in a directory the model can
write to" — which the file tool (issue #2) would hand it directly. `HOME` points at the workdir
so a command that drops a cache or config file does it inside the sandboxed root instead of the
operator's home.

Reject any passthrough name matching `/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` with a warning
unless `SHELL_TOOL_ALLOW_SECRET_PASSTHROUGH=1` is also set. An operator who genuinely needs to
hand a subprocess a credential can still do it; one who lists `*` -ish sets of names by habit
gets told.

### 4.3 — `exec.ts`: one `execFile`, bounded four ways

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

export function runCommand(
  cfg: ShellConfig,
  command: string,
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number; signal?: AbortSignal },
): Promise<ExecOutcome>;
```

Implementation notes, each of which is a bug if omitted:

- **`execFile(file, args, options)` with no `shell` option.** Node's default is `shell: false`;
  do not set it to anything, and never call `exec`. When `cfg.wrapper` is non-empty, the actual
  invocation becomes `execFile(wrapper[0], [...wrapper.slice(1), command, ...args])` — the
  wrapper is operator-authored argv, spliced in *before* the validated command, never parsed
  from a model argument.
- **`timeout` + `killSignal: "SIGKILL"`.** Node's `timeout` sends `killSignal` to the child, not
  to its descendants. Spawn with `detached: true` and, on timeout or abort, `process.kill(-pid)`
  to signal the whole process group; fall back to `child.kill()` if the group kill throws
  (`ESRCH`). Without this, `timeoutMs` bounds the direct child and orphans anything it spawned —
  which for `npm test` is the entire test run.
- **`maxBuffer`.** Set it to a hard byte ceiling (e.g. `4 * cfg.maxOutputChars`, allowing for
  multi-byte UTF-8). Exceeding it makes Node kill the child and reject with an `ENOBUFS`-flavored
  error whose `stdout`/`stderr` properties still hold what was captured. Catch that specific case
  and return a normal `ExecOutcome` with `truncated: true` — a command that printed too much must
  read as a truncated result, not as a plugin crash.
- **`signal: meta.signal`.** Forward the run's cancellation signal (fact: `ToolInvokeMeta.signal`
  already exists and SearXNG/Firecrawl already honor it). On abort, Node kills the child with
  `killSignal`; still do the process-group kill in an `abort` listener for the same descendant
  reason. This is what makes a shell command participate in PLAN-CANCELLATION's cancel-and-drain
  rather than surviving a failed run in the background.
- **Never resolve the promise before the child has actually exited.** `execFile`'s callback fires
  on close; don't race it against a timer.

### 4.4 — `tools.ts`: the spec, the handler, the toolset

One tool. Adding `shell_which`/`shell_env` reads as convenience and expands the surface for no
capability the model can't get from an allowlisted command.

```ts
export const SHELL_EXEC_TOOL: ToolSpec = {
  name: "shell_exec",
  description:
    "Run one allowlisted local command with explicit arguments. There is no shell: pipes, " +
    "redirection, globs, quoting and && are not interpreted. Chain steps with separate calls.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "bare command name, e.g. \"git\" (no path)" },
      args: { type: "array", items: { type: "string" }, description: "arguments, one per element" },
      workdir: { type: "string", description: "optional directory relative to the tool's root" },
      timeoutMs: { type: "number", description: "1000-<max>, default <default>" },
    },
    required: ["command"],
  },
};
```

The description is load-bearing, not decoration: it is what stops a local model from emitting
`{command: "ls -la | grep foo"}` on every call. Say "there is no shell" in the tool description
*and* return that exact sentence in the error when `command` contains a space or a metacharacter,
so the model's own error feedback teaches the calling convention.

Handler order — argument shape first, safety second, execution last:

1. `requireString(args, "command")` inside a try/catch returning `toolFail` (`PluginArgError`), as
   every existing plugin does.
2. `asStringArray(args["args"])` — reuse it; models emit `"a,b"` and `'["a","b"]'` for array
   arguments and the helper already absorbs both. Reject non-string-coercible entries.
3. `validateCommandInvocation(command, argv, cfg.allowed)` → `toolFail(err.message)` on
   `CommandSafetyError`.
4. Resolve `workdir` via the shared path primitive (§9); a rejection is `toolFail` with the
   `Blocked:`-prefixed reason, matching `url-safety.ts`'s convention.
5. `clampLimit(args["timeoutMs"], cfg.defaultTimeoutMs, cfg.maxTimeoutMs)` — note `clampLimit`'s
   floor is 1, so pass a sane minimum through explicitly rather than relying on it.
6. `guarded("shell", "exec", () => runCommand(...))`, so an unexpected throw is classified into
   the same one-line error taxonomy every other plugin produces.
7. Envelope (L7):

```ts
toolOk({
  exitCode, signal, timedOut, truncated, durationMs,
  stdout: sanitizeUntrustedText(scrubbed, PER_STREAM_MAX, "shell stdout"),
  stderr: sanitizeUntrustedText(scrubbed, PER_STREAM_MAX, "shell stderr"),
})
```

**Sanitization (layer 1, mandatory).** Command output is untrusted text by construction — a
model can `cat` a file someone else wrote or run a program that prints an injection payload.
`PER_STREAM_MAX` defaults to 8,000 chars per stream, giving a worst case (~16k plus envelope)
comfortably under the 32,000-char layer-2 backstop in `tool-registry.ts`; leaving room there is
the point, because that cap truncates blindly and would produce invalid JSON.

If you attach your own `[truncated N of M chars]` marker (recommended — a model that knows output
was cut will ask for `tail`), you must **scrub then truncate yourself** and never pass a
`maxLength` to `sanitizeUntrustedText`, per the rule in CLAUDE.md: `sanitizeUntrustedText` would
slice the marker back off. Use `scrubUntrustedText` + your own slice.

`createShellToolset(cfg: ShellConfig): ToolRegistration[]` returns one registration with
`toolset: "shell"`, no `unavailableReason` (§4.2), no `trustedResult` (never — that field is
whitelisted to the built-in state tools), and the `standalone` descriptor per L8, listing every
`SHELL_TOOL_*` env name.

### 4.5 — manifest and server wiring

`SHELL_MANIFEST` follows `SEARXNG_MANIFEST`'s shape: `toolset: "shell"`, `displayName: "Shell"`,
a description that says out loud that this runs local commands, and one `env` entry per variable
(`required: true` for `SHELL_TOOL_ALLOWED_COMMANDS` and `SHELL_TOOL_WORKDIR`). No `connect`.

In `packages/server/src/index.ts`, two edits:

```ts
const pluginManifests: PluginManifest[] = [..., SHELL_MANIFEST];
pluginToolsets = [...pluginToolsets, ...shellToolsetFromEnv()];
```

Everything else falls out with no further code: `/api/plugins/status` derives
`configured`/`connected` uniformly, `Canvas.tsx` renders a per-node "Shell" checkbox by mapping
over the status keys, `requiredToolsets(graph)` picks it up from `enabledToolsets`, and the
workflow-dependency banner plus the `/run` and `/step-start` 409 gates all work unchanged. Verify
this rather than assume it — the Canvas generalization is the whole reason a third plugin type
needed no Canvas edits (CLAUDE.md's MCP note), and it should hold for a fifth.

---

## 5. Testing

`vitest`, colocated `*.test.ts`, matching sibling plugins.

### 5.1 `command-safety.test.ts`

The interesting half of the suite, and all of it is pure:

- bare-name rejection: `/bin/ls`, `./run.sh`, `..`, `a\0b`, `""`
- allowlist miss names the current allowlist in the message
- `sudo`/`doas`/`su` refused even when explicitly allowlisted
- **L11's set refused even when explicitly allowlisted** — `git`, `aws`, `gh`, `npm`, `pnpm`,
  `yarn`, `docker` — each with an error naming the config-file reason rather than a bare "not
  allowed", so an operator reading it does not just add it to the allowlist
- **the two-call sequences that motivated L11 are unreachable**: assert
  `{command: "git", args: ["config", "core.pager", "sh -c x"]}` and
  `{command: "aws", args: ["configure", "set", "credential_process", "x"]}` are both refused at
  the command name — and note in the test's own comment that neither is caught by the
  metacharacter scan or the flag table, which is the whole point
- dangerous flags: `node -e`, `node --eval=x`, `npx -y`, `sh -c`, `env -S`, `find … -exec`,
  `git -c core.pager=…`, `xargs -I`
- combined short flags: `-yc` for `npx`
- case/`=`-suffix forms: `--EVAL=x`
- metacharacter args still rejected: `;`, `&&`, backtick, `$(…)`
- **a regression test asserting `plugin-mcp`'s `validateStdioServerConfig` still throws
  `McpConfigError`** (not `CommandSafetyError`) after the delegation — the wrapper's error-type
  translation is the easiest thing to lose in this refactor.

### 5.2 `exec.test.ts` — real subprocesses, no mocking

Follow `plugin-mcp`'s precedent (it spawns a real stdio server rather than faking a transport).
Two fixture strategies, both used, neither ambient:

- **Stock commands present on Linux and macOS**: `printenv` (exits 1 with no output when the
  named variable is unset — that is the non-zero-exit case, no shell needed) and `sleep` (the
  timeout and cancellation cases).
- **A fixture `bin/` directory** for anything needing more: the test writes an executable script
  into a temp dir, constructs its `ShellConfig` **directly** (not through `shellConfigFromEnv`)
  with `env.PATH` pointing at that dir and the script's name in `allowed`. This exercises
  PATH-based bare-name resolution (L3) as a side effect, and it is how the descendant-kill case
  gets a process that backgrounds a child without the tool ever seeing a shell.

Cases:

- **the env test, which is the important one**: set `FIRECRAWL_API_KEY=leak` in the *parent*
  process for the duration of the test, run `printenv`, assert the string `leak` does not appear
  in stdout and that `PATH`/`HOME` are the configured values. This is the single test that pins
  L4, and L4 is the difference between this tool and a credential-exfiltration primitive.
- non-zero exit ⇒ resolves with `exitCode: 1`, does not throw (L7)
- `timeoutMs` ⇒ `timedOut: true`, promise settles within a small multiple of the timeout
- **descendant kill**: run something that spawns a child that outlives its parent, assert the
  grandchild is gone after the timeout. Give this test an explicit vitest timeout — its failure
  mode is a hang, which otherwise just looks like a stuck suite (the same lesson
  `run-graph.test.ts`'s suspend test recorded in CLAUDE.md).
- `maxBuffer` exceeded ⇒ `truncated: true` with partial stdout, no throw
- `meta.signal` aborted mid-run ⇒ settles promptly, child gone
- `cwd` is the resolved workdir, and a `workdir` argument of `../` is refused

### 5.3 `tools.test.ts`

- allowlisted happy path returns `{ok:true, data:{exitCode:0, stdout:…}}` with `ok` first in the
  JSON (key order is contract — `toolOk`'s doc comment says so)
- a not-allowlisted command returns `ok:false` with a message naming the allowlist
- `args` supplied as `"a,b"` and as `'["a","b"]'` both work (`asStringArray`)
- output past `PER_STREAM_MAX` carries the truncation marker **and the marker survives** — i.e.
  it is the last thing in the string, proving scrub-then-truncate rather than
  `sanitizeUntrustedText(…, maxLength)`
- a stdout containing zero-width/tag characters comes back scrubbed
- `shellToolsetFromEnv({})` returns `[]`; with `SHELL_TOOL_ALLOWED_COMMANDS` set but no
  `SHELL_TOOL_WORKDIR`, also `[]`

### 5.4 Parity / golden fixtures

**No golden parity fixture in this plan.** The parity harness stubs the mock provider and (via
`net-stub.ts`) outbound HTTP; it has no stub for a subprocess, and a fixture that really spawns
`echo` would make the harness environment-dependent for the first time. A `shell` node kind (L9,
deferred) would need this properly, with a `(nodeId, sha256(argv))`-keyed table mirroring
`injectResponseTable` — the same shape PLAN-INTEGRATIONS.md's design trap 8 describes and that
the `fetch`-node fixture was deferred for. Record it as a tracked gap, not a hidden one.

### 5.5 e2e

**No Playwright spec.** Consistent with every plugin-shaped slice in this repo (Spotify, Gate,
MCP, SearXNG, Firecrawl, Discord all have none — CLAUDE.md records this pattern and that the
first plugin e2e spec is a separable piece of work). Coverage is the unit suite above, plus a
manual smoke test through the running server: set the two env vars, add a prompt node with the
`shell` toolset checked, confirm the workflow-dependency banner appears and Run is disabled when
they're unset, and that a real command runs when they are.

---

## 6. Ordering

1. `command-safety.ts` + tests, including L11's hard-refusal set; delegate `plugin-mcp`'s
   validator; full `pnpm test` green.
2. `path-safety.ts` + tests (§9) — or consume it, if `PLAN-FILE-TOOL.md` or `PLAN-GIT.md` landed
   first (both specify the identical module; `PLAN-GIT.md` §4.1 adds a `relativeTo` helper
   alongside it).
3. Package scaffold, `config.ts`, and the exec runner with tests (nothing model-facing yet). If
   `PLAN-GIT.md` landed first, **consume its `runArgv` from `@flowlathe/plugin-common`** (that
   plan's §4.2 owns the module precisely so this one inherits it) and add only the allowlist and
   `SHELL_TOOL_WRAPPER` layers §4.3 describes on top; do not author a second runner.
4. `tools.ts` + `manifest.ts` + tests.
5. Server wiring, README, manual smoke test.
6. CLAUDE.md notes (§10).

Steps 1–2 are the only ones touching existing code and are independently revertible.

---

## 7. Sandboxing, honestly

### 7.1 What tier 0 actually gives you

With no wrapper configured, a `shell_exec` call runs as the server's own OS user, on the server's
own filesystem, with the server's network access. The protections are: no shell interpretation
(L1), a command allowlist (L2/L3), a built environment with no credentials (L4), a pinned working
directory (L5), a wall-clock timeout, an output cap, and process-group cleanup. That is a real
reduction in blast radius and it is **not a security boundary**. An operator who allowlists an
interpreter, a package manager, or `find` has granted arbitrary local code execution to whatever
the model decides to do. Say this in README in those words.

**Two calls are one call, because the workdir persists.** L5 pins a working directory and L4 sets
`HOME` to it — both containment features — and together they mean anything a command *writes*
there is read back by the next command. That is what turns a config write into an execution
primitive (L11, `PLAN-DOMAIN-TOOLS.md` §1): `git config core.pager 'sh -c …'` is inert on its own,
and `git log` is inert on its own, and the pair is a shell. Any per-call reasoning about whether
an invocation is dangerous is therefore incomplete by construction — the unit of analysis is the
*session*, not the call. L11 handles the known instances of this; the general case is why tier 1
or tier 2 is the real answer.

Hermes's `agent/file_safety.py` says the same thing about its own guards, in its module docstring,
and it is right: *"Every guard here is defense-in-depth, NOT a security boundary: the terminal tool
runs as the same OS user and can read/write anything. The value is a clear denial for models that
respect tool errors plus a visible audit trail."*

### 7.2 Tier 1 — the container is the sandbox

The recommended deployment for a flow that uses this toolset is the existing image: `USER node`, a
declared filesystem with only `/app/data` and `/app/flows` as volumes, and a loopback-only publish.
Add a comment to the `Dockerfile` noting that `SHELL_TOOL_*` is deliberately **not** set there —
enabling it is an explicit `-e` at run time — and a README paragraph pointing at it. No functional
Dockerfile change.

### 7.3 Tier 2 — `SHELL_TOOL_WRAPPER`

A single operator-authored argv prefix, split once at boot (on whitespace, with no quoting
support — if an operator needs quoting they should write a two-line wrapper script and point at
that). Examples worth putting in the README verbatim:

```
SHELL_TOOL_WRAPPER="bwrap --unshare-all --die-with-parent --ro-bind /usr /usr --ro-bind /bin /bin \
  --ro-bind /lib /lib --bind $WORKDIR $WORKDIR --chdir $WORKDIR --"
SHELL_TOOL_WRAPPER="systemd-run --user --pipe --collect --property=MemoryMax=512M --"
SHELL_TOOL_WRAPPER="firejail --quiet --private=$WORKDIR --net=none"
```

The plugin does not validate wrapper semantics — it cannot know what `--` means to an arbitrary
launcher. It validates only that the first token resolves, and it never lets a model influence
any part of it. Note in the README that `--unshare-net` / `--net=none` is what actually stops an
allowlisted `curl` from becoming an exfiltration channel, and that no argv-level check can.

Prior art worth reading before extending this: `hermes-agent`'s `nix/sandbox.nix` and
`scripts/sandbox` (a real namespace-based sandbox) and `tools/terminal_tool_guards.py` (the
opposite approach: run a real shell, then denylist background operators, long-lived servers and
workdir metacharacters). This plan deliberately takes neither — Hermes must accept a shell because
its users type shell; flowlathe's caller is a model emitting JSON, so it can refuse one outright.

---

## 8. Scope: deliberately not built

- **`git`, GitHub, and AWS.** All three were originally intended to arrive through this toolset's
  allowlist and are now out of scope for it permanently (L11). `PLAN-GIT.md` builds local git as
  fixed argv templates with typed value slots; `PLAN-GITHUB.md` builds GitHub as an HTTP client
  with no subprocess at all; AWS gets nothing, because IAM is a strictly more expressive boundary
  than an argv filter and is enforced server-side (`PLAN-DOMAIN-TOOLS.md` D3). If this plan is
  ever built, it must not re-add any of them to the allowlist.
- **A `shell` node kind** (L9). A deterministic, wired-into-the-graph command node is a coherent
  follow-on mirroring `search`/`fetch`, and it needs the whole NodeKind checklist plus a parity
  stub for subprocesses (§5.4).
- **Human-in-the-loop approval.** Built separately in `PLAN-TOOL-APPROVAL.md`: an optional,
  default-off gate (`FLOWLATHE_TOOL_APPROVAL`) that suspends a gated toolset's calls for an
  operator decision, using the same `pause`/`user-input` suspend machinery this bullet originally
  proposed extending `ToolInvokeMeta` for — that plan found a decorator over the *built*
  `ToolRegistry` (applied only in `host-builder.ts`) reaches the same effect with no
  `ToolInvokeMeta` change at all. It is explicitly a bootstrapping/debugging aid for a
  newly-enabled toolset, never a substitute for L1–L10 above — enabling it does not change any
  allowlist, sanitization, or sandboxing behavior in this plan.
- **An audit trail.** Every `shell_exec` invocation ought to appear in the run log as a
  first-class event. It cannot: tool handlers have no `emit`. `Run.emit` exists (added for
  `node_skipped`) but is not reachable from `ToolInvokeMeta`. `console.log` at the server is the
  v1 substitute — do it, prefixed `[shell]`, with the command and argv but never the environment.
  (`PLAN-TOOL-APPROVAL.md`'s gate incidentally makes a *gated* call's `node_suspended` event a
  visible, persisted log line naming the tool — but only while gating is on for `shell`, and it
  records only that the call was attempted, not its result. This is not the audit trail this
  bullet describes and does not close it.)
- **rlimits, cgroups, seccomp, user switching, filesystem overlays** (L6). Delegated to the
  wrapper.
- **Windows** (L10).
- **Interactive/long-lived processes, background jobs, TTY allocation.** One command, one result,
  bounded by a timeout. Hermes's `terminal_tool_background.py` is what the alternative costs.

---

## 9. Shared with `PLAN-FILE-TOOL.md`

### 9.1 One path primitive, owned by whichever plan lands first

> **Superseded in part: this primitive already exists — do not write a new one.**
> `PLAN-STATE-FILES.md` implemented `resolveWithinRoot` (with tests) at
> `packages/runtime/src/state-file-io.ts:53`, after this section was written. `PLAN-GIT.md` §4.1
> resolves where it should live: extracted into a new dependency-free Node-only package
> `@flowlathe/path-safety`, depended on by `runtime` and `plugin-common` alike — which is the
> "new Node-only shared package" this section's own last paragraph already sanctioned. The
> specification below stands as documentation of what the function does; it is no longer a
> build instruction. If this plan is ever implemented, **consume** that package.

Three tools need "resolve a caller-supplied relative path under a fixed root, or refuse" — this
one, `PLAN-FILE-TOOL.md`, and `PLAN-GIT.md` (whose §4.1 also adds a `relativeTo(root, absolute)`
helper beside it, since git wants a repo-relative path after `--`). Its specification is identical
in all three and it must exist exactly once:

```ts
// packages/plugins/_common/src/path-safety.ts
export interface PathVerdict { ok: boolean; reason?: string; path?: string }
export function resolveWithinRoot(root: string, relative: string): PathVerdict;
```

Rules, checked in order: reject NUL; reject an absolute path or a `~` prefix (arguments are
always root-relative); reject any `..` component lexically (Hermes's `has_traversal_component`
cheap pre-check); `path.resolve(root, relative)`; `realpathSync` the target — or its nearest
existing ancestor, for a path being created — and require the result to be `root` or under
`root + sep`. Reasons are prefixed `Blocked:` so they read correctly appended to a node's failure
log, matching `url-safety.ts`.

**It cannot live in `@flowlathe/core`.** `realpathSync` is `node:fs`, and core must stay
genuinely isomorphic — `packages/web`'s `tsc --noEmit` pulls in all of core's *source* through
`export *`, and `skipLibCheck` does not shield source files (CLAUDE.md's `Buffer`-in-`BlobStore`
lesson). `@flowlathe/plugin-common` is the right home: Node-only by construction, already a
dependency of both plugins. If a future *node kind* ever needs it, move it to a new Node-only
shared package rather than into core — `@flowlathe/runtime` imports every `@flowlathe/node-*`
package, so a node kind importing `plugin-common` would drag a plugin helper library into
runtime's closure.

### 9.2 The combined threat: write-then-execute

Landing both issues creates a capability neither has alone. If `FLOWLATHE_FS_MODE=rw` and
`FLOWLATHE_FS_ROOT` overlaps `SHELL_TOOL_WORKDIR`, a model can write a file and then run it. The
mitigations, and where each lives:

- **L3** — a command must be a bare name resolved through a locked `PATH`, so a written file
  cannot be named directly.
- **L4/`SHELL_TOOL_PATH`** — `PATH` is never inherited and must not include the shared root, so a
  written file cannot shadow an allowlisted name.
- **`PLAN-FILE-TOOL.md`** — `fs_write` creates files mode `0o644`, never executable, and never
  follows a symlink out of the root.
- The residual: an operator who allowlists an interpreter (`node`, `python3`, `bash`) *and*
  enables `rw` on an overlapping root has composed "write a script, run the interpreter on it".
  The dangerous-flag table does not help — passing a *file path* to an interpreter is its normal
  use. This is a documented consequence of the operator's own two opt-ins, and README must say so
  in the same paragraph that describes both env vars.

---

## 10. `CLAUDE.md` notes (definition of done)

Add one entry, in this file's established voice — the surprises, not the summary:

- The command-safety checks moved from `plugin-mcp` to `plugin-common` and now serve two callers
  with different threat models (operator-authored MCP config vs. model-authored tool arguments);
  `validateStdioServerConfig` is now a wrapper whose only remaining jobs are refusing `cwd` and
  translating `CommandSafetyError` into `McpConfigError`.
- **The flag table is not the boundary; the allowlist is — and for one class of command the
  allowlist is unsound at any setting.** `awk`'s first positional is a program, `find -exec` takes
  one, a *subcommand* is invisible to a flag scan, and a command that writes its own config file
  (`git config`, `aws configure set credential_process`, `gh alias set`, `npm config`) turns two
  individually-harmless allowlisted calls into arbitrary execution — which no single-call check
  can see, because the unit of analysis is the session, not the call. Hence L11's
  `HARD_REFUSED_COMMANDS`. Do not add entries to `DANGEROUS_FLAGS_BY_COMMAND` under the impression
  that it makes an interpreter safe to allowlist, and do not remove anything from
  `HARD_REFUSED_COMMANDS` to "let an operator decide" — `git` and GitHub have real toolsets
  (`PLAN-GIT.md`, `PLAN-GITHUB.md`) and AWS deliberately has none (`PLAN-DOMAIN-TOOLS.md` D3).
- **`SHELL_TOOL_WORKDIR` + `HOME = workdir` are containment features that also give a written
  payload a home.** Anything one call writes there, the next call reads back. That is the
  mechanism behind L11 and the reason §7.1's honesty paragraph now talks about sessions rather
  than calls.
- **The child environment is built, not inherited**, and one test (`printenv` + a planted
  `FIRECRAWL_API_KEY`) is the only thing standing between this tool and a one-call credential
  dump. Do not "simplify" `exec.ts` by passing `process.env`.
- **`PATH` is locked and must never include the fs tool's root** — that combination re-enables the
  bare-name allowlist bypass (§9.2).
- **`detached: true` + `process.kill(-pid)` is load-bearing**: Node's `timeout`/`signal` kill the
  direct child only, so without it a timed-out `npm test` leaves the real work running.
- **`maxBuffer` overflow arrives as a rejection whose error still carries partial output** — it
  must be caught and turned into `truncated: true`, not surfaced as a plugin failure.
- Output is sanitized at layer 1 with its own truncation marker, so it uses
  `scrubUntrustedText` + a manual slice, never `sanitizeUntrustedText(…, maxLength)` (which would
  cut the marker off).
- No parity fixture and no e2e spec, and why (§5.4/§5.5) — tracked gaps.
- The approval gate is built separately in `PLAN-TOOL-APPROVAL.md`, as a decorator over the built
  `ToolRegistry` — no `ToolInvokeMeta` change needed. The audit-event deferral remains open (§8).

## 11. Definition of done

- [ ] `pnpm -r typecheck` and `pnpm test` green from the repo root (not just the new package —
      `plugin-mcp` is modified).
- [ ] `packages/plugins/shell` exists with the tests in §5.1–§5.3, including the `printenv`
      credential test, the descendant-kill test, and L11's hard-refusal cases.
- [ ] `plugin-mcp`'s existing tests pass unmodified, or with only an error-message update.
- [ ] `HARD_REFUSED_COMMANDS` covers L11's set and `sudo`/`doas`/`su`, is checked *before* the
      allowlist, and its error message names the reason rather than reading as "add it to the
      allowlist".
- [ ] With no env set: `/api/plugins/status` shows shell as not configured, a graph enabling it
      shows the workflow-dependency banner, and `/run` returns 409.
- [ ] With env set: a real command runs end to end through a prompt node's tool loop, verified
      manually against the running server.
- [ ] README documents every `SHELL_TOOL_*` variable, the tier-0/1/2 sandboxing story in the
      words of §7.1 (including the two-calls-are-one-call paragraph), the write-then-execute
      interaction of §9.2, and L11 — specifically that `git`, `aws`, `gh` and the package managers
      cannot be allowlisted, with a pointer to `PLAN-GIT.md`/`PLAN-GITHUB.md` for the first two.
- [ ] CLAUDE.md carries the §10 entry.
