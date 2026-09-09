# C8 — Git: server wiring, README, notes, manual smoke test

**Goal.** Register the plugin, document it, record what surprised you, and verify it end to end
against a real repository. **Human gate** — it cannot be closed on unit tests.

**Depends on:** C7. **Blocks:** nothing.

---

## Read

- `documentation/PLAN-GIT.md` §4.6 (wiring), §8 (the notes to record), §9 (definition of done).
- `documentation/notes/plugins-and-tools.md` — the Phase A entry (why `/api/plugins/status` needs
  no per-plugin code) and the Canvas generalization entry (why the checkbox needs no `Canvas.tsx`
  change).

## Modify

```
packages/server/src/index.ts                 # imports, pluginManifests, pluginToolsets — 2 lines
README.md                                    # Quickstart env table + a posture paragraph
documentation/notes/plugins-and-tools.md     # the §8 entries
documentation/notes/toolchain-and-build.md   # the @flowlathe/path-safety extraction from C5
```

Note the second notes file: C5 changed the package graph, and that belongs with the build notes,
not the plugin notes.

## Verify the fall-out rather than assuming it

- `GET /api/plugins/status` reports `git` with correct `configured`/`connected`.
- `Canvas.tsx` renders a per-node **Git** checkbox from the status keys alone.
- A graph enabling `git` with no env set shows the workflow-dependency banner and disables
  Run / Start Stepping.
- `POST /api/flows/:id/run` returns **409** with `git` in the `missing` list in that state.

## Manual smoke test (the human gate)

Point `GIT_TOOL_ROOT` at a **scratch clone**, never a repository with work you care about.

1. Unset → status not configured, banner appears, `/run` 409s.
2. `GIT_TOOL_ROOT` set, mode unset → a prompt node with the `git` toolset checked sees exactly
   **five** tools. Run `git_status` → `git_log` end to end through the tool loop.
3. `GIT_TOOL_MODE=rw` → **nine** tools. Run `git_add` → `git_commit` and confirm a real commit
   lands, via `git log` in your own shell.
4. `GIT_TOOL_ALLOW_PUSH=1` → **ten** tools.
5. Point `GIT_TOOL_ROOT` at a directory that is not a git work tree → zero registrations plus a
   boot warning.

Tool counts are the thing to actually check at each step; they are the whole of L6/L7.

## README must say

- Every `GIT_TOOL_*` variable.
- That identity (`user.name`/`user.email`), the credential helper and remotes are configured by
  the **operator, by hand, outside flowlathe** — this plugin reads that configuration and never
  writes it, and that is deliberate rather than an omission.
- Plainly, that `GIT_TOOL_MODE=rw` lets a model commit, and `GIT_TOOL_ALLOW_PUSH=1` lets it
  publish to a shared remote.
- That `git` cannot be reached through the (unbuilt) shell toolset and why — one sentence, pointing
  at `documentation/PLAN-DOMAIN-TOOLS.md`.

## Notes to record

`PLAN-GIT.md` §8 lists them. The ones that matter most:

- **This plugin never runs `git config` or `git remote`, and must never learn to** — those two
  subcommands are the entire reason `git` is hard-refused by the shell plan's L11.
- The model never supplies a subcommand or a flag; `commands.test.ts` is what enforces it.
- `git_diff` builds its `from..to` range from two separately validated refs.
- **`HOME`/`PATH` are inherited here, inverting the shell plan's rule** — with the reason, because
  it looks like a mistake otherwise.
- `GIT_TERMINAL_PROMPT=0` prevents a hang, not an untidy prompt.
- Sanitize after splitting records, never before.
- The parity-fixture gap (no subprocess stub in the harness) and the e2e gap.

And in `toolchain-and-build.md`: `@flowlathe/path-safety` exists, `runtime` and `plugin-common`
both depend on it, and `resolveWithinRoot` must never be copied into a third place.

## Do NOT

- Add a Playwright spec or a golden parity fixture. Both are tracked gaps with reasons
  (`PLAN-GIT.md` §6.6, §6.7).
- Add anything to `CLAUDE.md`.

## Done when

```
pnpm -r typecheck && pnpm test
node_modules/.bin/playwright test --config=playwright/playwright.config.ts   # existing specs still green
```

- All five manual steps verified by a human against a scratch repository.
- Every box in `PLAN-GIT.md` §9 ticked.

**Commit:** `Wire @flowlathe/plugin-git into the server`
