# Testing, Playwright and e2e

How to actually run the suites, the automation-only flakiness classes, and the e2e coverage gaps.

Moved verbatim out of `CLAUDE.md` when that file was split by topic; see it for the
index and for the invariants that apply repo-wide.

- **Playwright is pinned to `1.54.1`** (not registry `latest`) to match the browsers already
  cached at `~/.cache/ms-playwright` on this machine — bumping the version would trigger a browser
  download.
- **A controlled MUI field bound to "whichever node is selected" needs a `key` on the currently-
  selected node's id**, not just a `value` prop. `packages/web/src/pages/Canvas.tsx`'s node
  properties panel re-renders the same `Template`/`Provider`/`Model` `TextField`s across node
  selections; without `key={selectedNode.id}` on their wrapping element, React reuses the same
  underlying `<input>` DOM node across a selection change, and a fast automated `.fill()` right
  after clicking a different node could land while the field still reflected the *previous* node's
  identity — the edit silently applied in the wrong place. Reproduced only under Playwright's fast,
  no-delay interaction, not under a human (or MCP-driven) session with natural pauses between
  actions — that gap is exactly why it went undetected in manual smoke testing.
- **`pnpm exec playwright test` run from inside `playwright/` (which has no `package.json` — it's
  not a workspace package) intermittently crashes every worker with `TypeError: Cannot redefine
  property: Symbol($$jest-matchers-object)`, even at `--list`, before any test file loads.** Root
  cause not fully isolated (this machine also has a stray global `@playwright/test@1.54.2` install
  under `~/.local/share/fnm/.../lib/node_modules` that could be shadowing something via a `pnpm
  exec` resolution quirk from a non-package cwd), but the fix that reliably works is: run it from
  the repo root against the explicit config, via the locally pinned binary —
  `node_modules/.bin/playwright test --config=playwright/playwright.config.ts` — which is also
  exactly what the root `e2e` npm script does. Don't `cd playwright && pnpm exec playwright test`.
- **Two Playwright e2e gotchas found during manual/MCP-driven exploration of the Gate feature**
  (no Gate spec was ever actually committed — see the later note on plugin-shaped e2e coverage):
  (1) `.fill()` on a React-controlled
  `type="number"` MUI field is flaky specifically under fast/no-delay automation (passes reliably
  via a human or MCP-paced session, same class of issue as the stale-DOM entry above) — use
  `.pressSequentially()` for numeric fields instead. (2) Default node-add positions are spaced far
  enough apart (see below) that a 3rd node can land outside the initial viewport with a stale/wrong
  `boundingBox()`, silently dropping a drag-to-wire gesture — click "Fit View" before wiring nodes
  that were just added. Relatedly, `Canvas.tsx`'s `addNode()` position formula was widened
  (`x: 80 + ns.length * 260`, was `* 60`) so the diamond Gate — visually wider than a rect node —
  never lands overlapping the previous node by default.
- **No Playwright e2e spec was added for Phase A (SearXNG), despite PLAN-INTEGRATIONS.md §8
  asking for "one spec per phase."** `playwright/tests/` currently has no spec at all for
  Spotify, Gate, or MCP either — despite CLAUDE.md's own Gate/Slice-6 entries above describing
  Playwright gotchas as if such specs exist, the actual spec files were apparently never
  committed (or were later removed) for any plugin-shaped slice; only the core numbered
  slice0–slice7 flow specs are present. Given that pattern, Phase A's unit-test coverage
  (`client.test.ts`/`tools.test.ts`/`liveness.test.ts`/`env.test.ts`, all offline against an
  injected `fetchImpl`) was prioritized over writing the first-ever plugin e2e spec from
  scratch, which would also need a fixture SearXNG HTTP server wired into
  `playwright/playwright.config.ts`'s `webServer.env` (the same gap this file already flags as
  *not done* for MCP). Left as a real, tracked gap for whoever picks up e2e coverage for the
  plugin surface generally — not SearXNG-specific.
