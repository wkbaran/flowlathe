# C5 — Shared plumbing for git: `@flowlathe/path-safety` and `runArgv`

**Goal.** Two shared primitives the git plugin needs, neither of which may be duplicated. One is a
pure refactor of existing tested code; one is new. Nothing model-facing.

**Depends on:** C1. **Blocks:** C6.

This is the highest-blast-radius chunk in the set — it touches `@flowlathe/runtime`, which both
execution engines depend on. It is isolated for exactly that reason. Land it green before
anything builds on it.

---

## Part 1 — extract `resolveWithinRoot` into `@flowlathe/path-safety`

### The situation

`resolveWithinRoot` **already exists**, complete and tested, at
`packages/runtime/src/state-file-io.ts:53` (PLAN-STATE-FILES put it there). Do not write a second
copy: `documentation/notes/security.md` records what duplicating a containment primitive already
cost this repo once, when `url-safety.ts` and `allowed-hosts.ts` drifted and the same SSRF gaps
had to be found and fixed twice.

It cannot be imported where it stands: `@flowlathe/plugin-common` must not depend on
`@flowlathe/runtime` (runtime's closure pulls in every node kind, and the locked direction is that
plugin-common is a helper library *for* plugins, not for what plugins plug into). It cannot move
into `@flowlathe/core` either — `realpathSync` is `node:fs` and core must stay isomorphic
(`CLAUDE.md` rule 1).

### The resolution

A new, dependency-free, Node-only package that both `runtime` and `plugin-common` depend on.
`PLAN-SHELL-TOOL.md` §9.1's own last paragraph sanctioned this shape; `PLAN-GIT.md` §4.1 records
the decision.

### Create

```
packages/path-safety/package.json      # name @flowlathe/path-safety, NO dependencies
packages/path-safety/tsconfig.json
packages/path-safety/src/index.ts
packages/path-safety/src/path-safety.ts
packages/path-safety/src/path-safety.test.ts
```

`packages/*` is already a workspace glob.

### Modify

```
packages/runtime/src/state-file-io.ts        # delete resolveWithinRoot + nearestExistingAncestor +
                                             #   PathVerdict; import them instead
packages/runtime/src/state-file-io.test.ts   # move the resolveWithinRoot describe block out
packages/runtime/src/state-store.ts:5        # import from @flowlathe/path-safety
packages/runtime/package.json                # + "@flowlathe/path-safety": "workspace:*"
packages/plugins/_common/package.json        # + "@flowlathe/path-safety": "workspace:*"
```

### Add for C6/C7

`relativeTo(root, absolute)` beside `resolveWithinRoot` — git wants a repo-relative path after
`--`, and there are four call sites that would otherwise each write `path.relative`.

### Traps

- **This is a pure refactor. Zero behavior change.** Move the function body verbatim, including its
  doc comment and its documented TOCTOU gap. If you find yourself improving it, stop.
- The existing tests move with it and must pass **unmodified except for the import path**. Needing
  to change an assertion means the move changed behavior.
- `state-file-io.ts` keeps `readStateFile`/`writeStateFile`/`mintVersionedCopy` and its
  `scrubUntrustedText` import. Only the path primitive leaves.
- Re-exporting from `state-file-io.ts` for compatibility is unnecessary — grep first, but the only
  consumers are `state-store.ts` and the test.

---

## Part 2 — `runArgv` in `@flowlathe/plugin-common`

### Read

`documentation/PLAN-GIT.md` §4.2 (the signature and the five must-haves) and §6.5 (the tests).

### Create

```
packages/plugins/_common/src/exec.ts
packages/plugins/_common/src/exec.test.ts
```

### Modify

```
packages/plugins/_common/src/index.ts   # export both new modules
```

### Traps — each is a bug if omitted

There is **no existing exemplar in this repo**; `git-history.ts` is `execFileSync` with no timeout
and no bounds. `PLAN-GIT.md` §4.2 is the whole specification.

- `execFile`, no `shell` option set to anything, never `exec`.
- **`detached: true` + `process.kill(-pid)`** on timeout or abort, falling back to `child.kill()`
  on `ESRCH`. Node's `timeout`/`signal` kill only the direct child; git routinely spawns `ssh`,
  credential helpers and hooks.
- **`maxBuffer` overflow arrives as a rejection whose error still carries partial output.** Catch
  that case and return `truncated: true` — not a plugin crash.
- Forward `signal` so a command participates in cancel-and-drain
  (`documentation/notes/engines.md`, the cancellation entry).
- Never resolve before the child has exited. Don't race the callback against a timer.

### Do NOT

- Add an allowlist, a `SHELL_TOOL_WRAPPER`, or any command validation. Those are shell-tool
  concepts with no meaning here; `PLAN-SHELL-TOOL.md` is deferred and will *inherit* this runner.
- Add a model-supplied timeout parameter.

---

## Done when

```
pnpm -r typecheck && pnpm test        # from the root — runtime is modified, both engines depend on it
```

- Every pre-existing test passes, including the full `@flowlathe/runtime` suite and the
  interpreter/compiler parity suite. This chunk changes no behavior anywhere.
- `path-safety.test.ts` is the moved suite, import path aside.
- `exec.test.ts` covers §6.5, including the **descendant-kill case with an explicit vitest
  timeout** — its failure mode is a hang, which otherwise just looks like a stuck suite.

**Commit:** `Extract path-safety into its own package and add runArgv to plugin-common`
