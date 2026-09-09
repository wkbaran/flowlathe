# C7 — `@flowlathe/plugin-git`: the 10 tools and the manifest

**Goal.** Turn the argv templates into `ToolRegistration`s, with real-git-repository tests.

**Depends on:** C6. **Blocks:** C8.

---

## Read

- `documentation/PLAN-GIT.md` §3 — the argument tables and return shapes.
- `documentation/PLAN-GIT.md` §4.5 (handler order, sanitization caps, the split-then-sanitize
  rule), §4.6 (manifest), §6.4 (tests).
- `documentation/notes/security.md` — the sanitization-boundary entry.
- `documentation/notes/plugins-and-tools.md` — `toolOk`/`toolFail` key order, `trustedResult`.

## Copy the shape from

- `packages/plugins/discord/src/tools.ts` — handler order (validate → check → `guarded` →
  envelope), `summarizeMessage`'s per-field sanitization, `createDiscordToolset`'s structure.
- `packages/plugins/searxng/src/manifest.ts` — manifest shape.
- `packages/server/src/routes/flows-versioning.test.ts`, the **"git history (Layer 2, S6)"**
  block — how this repo already creates real git repositories in tests, unmocked. Follow it.

## Create

```
packages/plugins/git/src/tools.ts
packages/plugins/git/src/manifest.ts
packages/plugins/git/src/tools.test.ts
```

## Modify

```
packages/plugins/git/src/config.ts     # gitToolsetFromEnv returns real registrations
packages/plugins/git/src/index.ts      # export the manifest and the toolset factory
```

## Traps

- **A non-zero exit is a *successful* tool call.** Return `toolFail` carrying git's own stderr — a
  model needs to read "nothing to commit, working tree clean". Reserve a `guarded`-classified
  failure for "could not run git at all".
- **Sanitize after splitting records, never before.** Scrubbing strips control characters and the
  field separators (`%x1f`) *are* control characters. Reversing the order silently collapses every
  record into one. This is the most likely bug in this chunk.
- **`git log -z` terminates records with NUL**, which cannot appear in a commit object, so record
  splitting is exact. Fields within a record are still `%x1f`-separated — a commit subject could in
  principle contain one. `git-history.ts` has the identical latent issue; accept it, note it, don't
  invent a scheme.
- **The diff and file-content fields own their truncation marker**, so they scrub-then-slice by
  hand and never pass a `maxLength` to `sanitizeUntrustedText`. Every other field uses the §4.5
  caps directly.
- **`git_show` refuses binary content** — a NUL byte in the output means `toolFail("Blocked: …")`,
  not 12,000 characters of noise in a prompt.
- **Never set `trustedResult`.**
- Timeouts are fixed: 15s read, 120s for `git_push`.

## Do NOT

- Add `--amend`, `-a`/`--all` to commit, `--force`/`--detach` to switch, `--set-upstream` or any
  refspec to push, or any flag not already in C6's templates. If a template needs changing, change
  `commands.ts` and its test first, deliberately.
- Add an eleventh tool.
- Touch `packages/server/src/index.ts` — that is C8.

## Done when

```
pnpm -r typecheck && pnpm test
```

- `tools.test.ts` builds a fixture repo per test with `git init`, an explicit local
  `user.email`/`user.name` and `commit.gpgsign=false`, so the suite does not depend on the
  machine's global gitconfig or a signing key.
- It covers §6.4 in full, including these two, each asserting **no subprocess was spawned** rather
  than merely that the call failed:
  - a path outside the root (`"../../etc/passwd"`, and an absolute path) is refused;
  - a ref that is a flag (`"--output=/tmp/pwned"`, `"-o"`, `"a/../../b"`) is refused. This is the
    `git-history.ts` regression, generalized.
- Also: `git_add` + `git_commit` produces a real commit verified by re-reading it through
  `git_log`; committing nothing staged returns `ok:false` with git's message and does not throw;
  a commit message with zero-width/tag characters comes back scrubbed; an over-long diff's
  truncation marker is the **last** thing in the string; `git_show` on a binary blob refuses.
- Write-tool absence in `ro` is asserted **by registration name**, not array length.

**Commit:** `Add @flowlathe/plugin-git toolset and manifest`
