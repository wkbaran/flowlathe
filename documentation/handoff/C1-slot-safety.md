# C1 — `slot-safety.ts` in `@flowlathe/plugin-common`

**Goal.** Add the shared validators that let a model-supplied value reach an argv element or a URL
path segment safely. Pure functions, no I/O. Both the `github` and `git` plugins depend on this.

**Depends on:** nothing. **Blocks:** C2 and C5, i.e. everything.

---

## Read

- `documentation/PLAN-DOMAIN-TOOLS.md` §1 and §2 — *why* this exists. Read once; later chunks
  don't need it.
- `documentation/PLAN-DOMAIN-TOOLS.md` §7 — the module's specification and the four rules every
  validator shares.
- `documentation/PLAN-GITHUB.md` §4.1 (the `gitRefSlot` rule list) and §6.1 (the test list).
- `documentation/notes/security.md` — the "HANDOFF-QUICK-FIXES" entry. It is the source of two of
  the four rules and explains why they are not paranoia.

## Copy the shape from

- `packages/plugins/_common/src/args.ts` + `args.test.ts` — module layout, error-class precedent
  (`PluginArgError`), test style. Your `SlotError` mirrors it.

## Prior art the rules come from (read, don't modify)

- `packages/server/src/git-history.ts:44-50` — `SHA_PATTERN` and its doc comment. This is the
  leading-dash rule: `execFileSync` blocks shell injection but a `-`-prefixed *value* is parsed by
  git as an *option*.
- `packages/plugins/discord/src/client.ts:5-17` — `ID_PATTERN`/`requireId`. This is the `..` rule:
  undici normalizes `..` during URL parsing, so an id containing `/../` retargets the request at a
  different API endpoint with no filesystem involved.

## Create

```
packages/plugins/_common/src/slot-safety.ts
packages/plugins/_common/src/slot-safety.test.ts
```

## Modify

```
packages/plugins/_common/src/index.ts      # add `export * from "./slot-safety.js";`
```

## Exports

Exactly as `PLAN-DOMAIN-TOOLS.md` §7 specifies: `SlotError`, `gitRefSlot`, `repoSlugSlot`,
`intSlot`, `textSlot`.

## Traps

- **`intSlot` throws; it does not clamp.** `clampLimit` in `args.ts` silently falls back to a
  default — that is right for a "how many results" argument and wrong for a slot, where an
  unvalidatable value must not quietly become a default. Assert the difference in a test so nobody
  unifies the two later.
- **`gitRefSlot` must allow interior `/`** (`feature/thing` is an ordinary branch name) while
  rejecting `..`, leading/trailing `/`, and `//`. It serves both a URL path segment (C3) and an
  argv element (C7), so it needs the union of both rule sets.
- **`textSlot` keeps `\n` and `\t`** — it is for commit messages and issue bodies — while
  rejecting NUL and every other control character.
- Relative import specifiers carry an explicit `.js` extension even though the source is `.ts`.
  That is correct here, not a mistake (`documentation/notes/toolchain-and-build.md`).

## Do NOT

- Put this in `@flowlathe/core`. Core must stay isomorphic; more importantly this belongs with the
  plugin helpers.
- Add a path validator. Path containment is C5's job and already exists elsewhere.
- Add validators nothing consumes yet. Five functions, no more.

## Done when

```
pnpm -r typecheck && pnpm test        # from the repo root — plugin-common has 5 existing consumers
```

- `slot-safety.test.ts` covers every case in `PLAN-GITHUB.md` §6.1, including `-o`,
  `--upload-pack`, `a/../../b`, `a//b`, `x.lock`, a 256-char ref, `owner`, `a/b/c`, and the
  `intSlot`-throws-rather-than-clamps assertion.
- The five existing plugins' suites still pass untouched.

**Commit:** `Add slot-safety validators to plugin-common`
