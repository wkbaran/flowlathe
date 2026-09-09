# C4 — GitHub: server wiring, README, notes, manual smoke test

**Goal.** Register the plugin with the server, document it, record what surprised you, and verify
it end to end against a real repository. This chunk has a **human gate** — it cannot be closed on
unit tests.

**Depends on:** C3. **Blocks:** nothing.

---

## Read

- `documentation/PLAN-GITHUB.md` §4.6 (wiring), §8 (the notes to record), §9 (definition of done).
- `documentation/notes/plugins-and-tools.md` — the PLAN-INTEGRATIONS Phase A entry, which explains
  why `/api/plugins/status` needs no per-plugin code, and the Canvas generalization entry, which
  explains why the per-node checkbox needs no `Canvas.tsx` change.

## Modify

```
packages/server/src/index.ts               # lines ~6-9 (imports), ~52 (pluginManifests), ~82 (pluginToolsets)
README.md                                  # Quickstart env table + a posture paragraph
documentation/notes/plugins-and-tools.md   # the §8 entries — NOT CLAUDE.md
```

The existing four plugins on those exact lines are the template. Two edits, both one line.

## Verify the fall-out rather than assuming it

Everything below is supposed to work with no further code. That has held from the third plugin
onward, but check it rather than trusting it:

- `GET /api/plugins/status` reports `github` with correct `configured`/`connected`.
- `Canvas.tsx` renders a per-node **GitHub** checkbox, from the status keys alone.
- A graph enabling `github` with no env set shows the workflow-dependency banner and disables
  Run / Start Stepping.
- `POST /api/flows/:id/run` returns **409** with `github` in the `missing` list in that state.

## Manual smoke test (the human gate)

You need a fine-grained PAT and a scratch repository.

1. Unset everything → status shows not configured, banner appears, `/run` 409s.
2. `GITHUB_TOKEN` only → status shows configured but **not** connected, with a reason naming
   `GITHUB_ALLOWED_REPOS`.
3. Both set, `GITHUB_MODE` unset → a prompt node with the `github` toolset checked runs
   `github_list_issues` and `github_get_checks` end to end through the tool loop. Confirm the
   model's tool list contains **five** tools, not eight.
4. `GITHUB_MODE=rw` → the list becomes eight.

## README must say

- Every `GITHUB_*` variable, with `GITHUB_TOKEN` marked secret.
- That the PAT should be **fine-grained and scoped to the allowlisted repositories only** — it is
  the real boundary; `GITHUB_ALLOWED_REPOS` is what flowlathe can enforce on top.
- Plainly, that `GITHUB_MODE=rw` lets a model open issues, comments and pull requests **under the
  token owner's identity**.
- That auth is configured by hand and there is no Connect button for this plugin.

## Notes to record

Into `documentation/notes/plugins-and-tools.md`, in that file's voice — the surprise, not the
summary. `PLAN-GITHUB.md` §8 lists them; the ones that matter most:

- `/issues` returns pull requests too, and `github_comment` deliberately *relies* on the same fact.
- A primary rate limit is a **403**, not a 429 — and the three-way split that follows.
- `GET /rate_limit` as a free liveness+auth probe, still behind `CachedLivenessProbe`.
- **The parity-fixture gap and its specific reason**: `injectNetStubTable` only stubs
  `RuntimeHost.net`, which a plugin's own client never goes through. This is *not* the usual
  "no fixture because subprocess" reason and should not be recorded as if it were.

## Do NOT

- Add a Playwright spec. No plugin in this repo has one; writing the first is separable work
  (`documentation/notes/testing-and-e2e.md`).
- Add a golden parity fixture. See the gap above — it needs harness changes out of scope here.
- Add anything to `CLAUDE.md`. It is an index plus repo-wide invariants now.

## Done when

```
pnpm -r typecheck && pnpm test
node_modules/.bin/playwright test --config=playwright/playwright.config.ts   # existing specs still green
```

- All four manual steps above verified by a human against a real repository.
- Every box in `PLAN-GITHUB.md` §9 ticked.

**Commit:** `Wire @flowlathe/plugin-github into the server`
