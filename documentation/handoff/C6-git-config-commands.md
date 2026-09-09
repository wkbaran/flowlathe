# C6 — `@flowlathe/plugin-git`: package, `config.ts`, `commands.ts`

**Goal.** Scaffold the package, build the boot-time config, and write the ten argv templates with
their pure tests. Nothing model-facing yet — no handlers, no registrations.

**Depends on:** C5. **Blocks:** C7.

---

## Read

- `documentation/PLAN-GIT.md` §2 (locked decisions L1–L11 — L1 is the entire security design), §3
  (**the argv templates are the specification**), §4.0, §4.3, §4.4, §6.1, §6.3.
- `documentation/PLAN-DOMAIN-TOOLS.md` §1.1 and §2 — why the model may never supply a subcommand.
  Read this before writing `commands.ts`; it is what stops you "helpfully" adding a flag slot.
- `documentation/notes/toolchain-and-build.md` — the TypeScript pin.

## Copy the shape from

- **`packages/server/src/git-history.ts`** — the pattern this generalizes. `execFileSync("git",
  ["-C", dir, ...args])` with fully literal argv, one caller-supplied value validated against
  `SHA_PATTERN` first, and a doc comment explaining argument injection. Read it first.
- `packages/plugins/searxng/src/env.ts` — the `xConfigFromEnv` shape.
- `packages/plugins/searxng/package.json` and `tsconfig.json` — copy verbatim, change the name.

## Create

```
packages/plugins/git/package.json      # deps: @flowlathe/core, @flowlathe/plugin-common only
packages/plugins/git/tsconfig.json
packages/plugins/git/src/index.ts
packages/plugins/git/src/config.ts
packages/plugins/git/src/commands.ts
packages/plugins/git/src/config.test.ts
packages/plugins/git/src/commands.test.ts
```

## Traps

- **`commands.ts` holds pure functions from validated slots to `string[]`.** No I/O, no
  `ToolInvokeMeta`, no `guarded`. That purity is what makes `commands.test.ts` — the highest-value
  file in this plan — possible, because it asserts the exact argv array a set of arguments
  produces. That test is what catches a flag leaking into a slot.
- **Every template starts `["-C", root, …]`** and **every pathspec is preceded by a literal `--`**.
  Both are load-bearing and both are easy to forget on the tenth template.
- **An absent optional slot removes its argv element entirely.** `git log ""` is not `git log`.
- **`git_diff` builds `from..to` itself** from two independently validated refs. A single
  model-supplied `"a..b"` string would be a single model-supplied `"a --output=/etc/x"` string.
- **`HOME` and `PATH` are inherited here, deliberately inverting the shell plan's rule** — git
  needs `~/.gitconfig`, the credential helper and `ssh`. Everything else is stripped: a git hook is
  arbitrary code running with this environment.
- **`GIT_TERMINAL_PROMPT=0` is not cosmetic.** Without it a push with unusable credentials *hangs*
  on a terminal prompt until the timeout.
- **`config.ts` is the only place this plugin does I/O outside a tool call**, and it happens once
  at boot: `realpathSync`, plus `git rev-parse --is-inside-work-tree` (the same check
  `isGitWorkTree` already makes). `unavailableReason` must never be set — there is nothing to
  probe, and it is called synchronously on every `GraphEngine` construction.
- `GIT_TOOL_ALLOW_PUSH=1` without `GIT_TOOL_MODE=rw` is ignored, with a warning. Fail closed.

## Do NOT

- Write a `git config`, `git remote`, `git clone`, `git fetch`, `git pull`, `git merge`,
  `git reset`, `git rebase`, `git stash`, `git clean`, `git rm` or `git tag` template. `PLAN-GIT.md`
  §5 lists every exclusion and why. `config` and `remote` in particular are the exact attack
  `PLAN-DOMAIN-TOOLS.md` §1.1 describes.
- Add a `timeoutMs` slot. Timeouts are fixed per tool (15s read, 120s push).
- Add a `CachedLivenessProbe`.
- Write `tools.ts` or `manifest.ts` — that is C7.

## Done when

```
pnpm -r typecheck && pnpm test
```

- `commands.test.ts` asserts the exact argv for all ten tools across every present/absent
  combination of optional slots, and specifically that: every template starts `-C <root>`; every
  pathspec is immediately preceded by `--`; an absent `ref` removes its element; `git_diff` with
  both refs produces **one** `from..to` element; `git_push` produces exactly
  `["-C", root, "push", remote, "HEAD"]` for every input.
- `config.test.ts` covers §6.3, including the **environment test**: plant `FIRECRAWL_API_KEY=leak`
  and `GITHUB_TOKEN=leak2` in the parent process and assert neither name appears in `cfg.env`,
  while `HOME`/`PATH` do and `GIT_TERMINAL_PROMPT` is `"0"`. That one test is what stands between
  a git hook and every credential the server holds.
- Registration counts: `ro` ⇒ 5, `rw` ⇒ 9, `rw` + push ⇒ 10, push-without-rw ⇒ 5 + warning.

**Commit:** `Add @flowlathe/plugin-git config and argv templates`
