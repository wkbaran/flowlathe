# flowlathe — agent notes

Read `documentation/PLAN.md` first; it is the source of truth for architecture decisions.
`documentation/` holds every implementation plan (`PLAN-*.md`), audit follow-up (`FIX-*.md`) and
handoff brief (`handoff/`).

This file records things that **surprised an implementing agent**, so the next one doesn't
rediscover them the hard way. It used to hold all of them inline and had grown to ~1,300 lines —
loaded into every agent's context whether relevant or not. The detail now lives in
`documentation/notes/`, split by subsystem. What stays here is the index, plus the handful of
invariants that apply to a change **anywhere** in the repo.

---

## Read before changing anything

Eight rules that have each cost someone real time, and that are not scoped to one subsystem.

1. **`@flowlathe/core` must stay genuinely isomorphic — no `Buffer`, no `node:*` imports,
   anywhere in it.** Workspace packages resolve to raw `.ts` source (not built `.d.ts`), so
   `tsc --noEmit` in `packages/web` pulls in *all* of core's source transitively through
   `export *`, even parts web never imports — `skipLibCheck` doesn't shield source files, only
   `.d.ts`. A `BlobStore` interface typed with `Buffer` broke `web`'s typecheck even though web
   never touches blobs. Fix: use `Uint8Array` in shared contracts (works in both environments);
   concrete Node-side implementations (`Buffer` extends `Uint8Array`) satisfy it for free.

2. **There are two execution engines and they must move in lockstep.** The interpreter
   (`packages/interpreter`) and the compiled-script emitter (`packages/compiler`) implement the
   same semantics twice, and several conventions are mirrored *by hand* rather than shared —
   scoped activation keys, `contextNodeId`, schema defaults. A change to one that isn't made to
   the other usually fails silently rather than loudly. See
   [`notes/engines.md`](documentation/notes/engines.md) before touching either.

3. **Run the full suite from the repo root, not just the package you touched.**
   `pnpm -r typecheck && pnpm test`. Workspace packages resolve to raw source, so a change in
   `core` or `plugin-common` typechecks against every consumer — that is the whole point of rule 1
   and it only shows up in a root-level run.

4. **Playwright runs from the repo root against the explicit config**:
   `node_modules/.bin/playwright test --config=playwright/playwright.config.ts` (what the root
   `e2e` script does). Do **not** `cd playwright && pnpm exec playwright test` — it intermittently
   crashes every worker before any test loads. See
   [`notes/testing-and-e2e.md`](documentation/notes/testing-and-e2e.md).

5. **Never resolve `latest` for `typescript` or `@playwright/test`.** Both are pinned
   deliberately (`typescript@5.9.3` because TS 7 is a different compiler; Playwright `1.54.1` to
   match the browsers already cached on this machine). Copy a sibling package's versions verbatim
   when scaffolding a new one. See
   [`notes/toolchain-and-build.md`](documentation/notes/toolchain-and-build.md).

6. **Untrusted text reaching a model's context is sanitized at two layers, and neither may be
   deleted** — per-field at the source (tight, caller-owned caps) plus one generous whole-result
   cap at `ToolRegistry.invoke`. A caller that owns its own truncation marker must
   scrub-then-truncate itself and never pass a `maxLength` to `sanitizeUntrustedText`. See
   [`notes/security.md`](documentation/notes/security.md).

7. **An unset env var must produce zero tool registrations.** `/api/plugins/status` derives
   `configured`/`connected` uniformly from whether a toolset has any live registrations, with no
   per-plugin special-casing — a plugin that registers unconditionally and always fails
   `unavailableReason()` silently reads as "configured". See
   [`notes/plugins-and-tools.md`](documentation/notes/plugins-and-tools.md).

8. **Every port a node declares via `inputPorts()` must have a real incoming edge** — the
   interpreter's `isReady()` requires all declared ports to be non-`empty`, and a port with zero
   edges stays `empty` forever. "Optional" only ever meant "allowed to resolve to `never`". There
   are exactly two documented exceptions (Loop/Map's injected body port, and a Prompt template
   variable satisfied by a declared State entry); both are in
   [`notes/nodes-and-runtime.md`](documentation/notes/nodes-and-runtime.md).

---

## Where the detailed notes live

Read the file matching what you're about to change. Each holds the verbatim content that used to
be inline here.

| File | Covers |
|---|---|
| [`notes/toolchain-and-build.md`](documentation/notes/toolchain-and-build.md) | Pinned versions, `.js` extensions on `.ts` imports, no `tsc -b`, why `web` never imports `persistence` |
| [`notes/engines.md`](documentation/notes/engines.md) | Interpreter/compiler parity, router scopes, Loop/Map regions, activation keys, cancellation, generated variable names, the `remaining()` concurrency bug |
| [`notes/nodes-and-runtime.md`](documentation/notes/nodes-and-runtime.md) | Prompt/Gate/State/Context semantics, compaction, file-backed State, the port-needs-an-edge exceptions |
| [`notes/plugins-and-tools.md`](documentation/notes/plugins-and-tools.md) | `ToolRegistration`, `plugin-common` helpers, the missing-dependency gate, MCP/Spotify/SearXNG/Firecrawl/Discord scope cuts, `search`/`fetch` node kinds |
| [`notes/security.md`](documentation/notes/security.md) | The two-layer sanitization boundary, argument injection, URL path traversal, SSRF blocklist drift |
| [`notes/persistence.md`](documentation/notes/persistence.md) | Schema, `content_hash` and flow-version dedup/restore, execution retention and blob GC |
| [`notes/flow-dsl-and-store.md`](documentation/notes/flow-dsl-and-store.md) | `.flow` text, round-trip canonicalization, the `flowlathe` CLI bin, `fs.watch` on WSL2 |
| [`notes/server-and-deployment.md`](documentation/notes/server-and-deployment.md) | Pre-built SPA serving, `HOST`/`Host`-allowlist network posture, the Docker image, the trigger subsystem |
| [`notes/testing-and-e2e.md`](documentation/notes/testing-and-e2e.md) | Running Playwright, automation-only flakiness (`.fill()` on controlled fields, stale bounding boxes), the plugin e2e coverage gap |

Cross-cutting: a Canvas/UI note usually sits in the file for the feature it arrived with rather
than a UI file of its own — `xyflow`'s `parentId` containment is in `engines.md` (it came with
subgraph bodies), the selection-reset-on-reload note is in `persistence.md` (it came with version
restore). Grep `documentation/notes/` rather than assuming.

---

## Adding a note

When something in this project surprises you, say so to the developer you're working with *and*
write it down — that is what keeps these files worth loading.

- Put it in the `documentation/notes/` file for the subsystem, not here. This file only grows for
  a genuinely repo-wide invariant, and then only as a short entry with a pointer.
- Record the **surprise**, not the summary. "X exists and does Y" is documentation; "X looks like
  it does Y and actually does Z, and here is the failure that taught us" is a note.
- Say what was *verified* versus *assumed*, and correct an earlier note in place when it turns out
  to be wrong — several entries carry an explicit **Correction:** for exactly that reason.
- Record deliberate scope cuts and known gaps as such, so the next agent doesn't re-file them as
  new bugs, and so nobody "fixes" a decision.
