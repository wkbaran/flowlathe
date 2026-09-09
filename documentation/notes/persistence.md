# Persistence, versioning and retention

The SQLite schema, flow-version dedup/provenance, and the two garbage collectors.

Moved verbatim out of `CLAUDE.md` when that file was split by topic; see it for the
index and for the invariants that apply repo-wide.

- **`packages/persistence/src/schema.ts` implements the full schema from PLAN.md's "Persistence
  schema" section up front**, not just the tables slice 0 touches. That schema was already fully
  specified in the plan (not something this agent designed), and SQLite/drizzle migrations make
  incremental `ALTER TABLE` additions more painful than just generating the whole thing once via
  `drizzle-kit generate`. **Correction (PLAN-EXECUTION-RETENTION.md audit):** this used to claim
  `branches`/`snapshots` have a circular FK relationship
  (`branches.forked_from_snapshot_id → snapshots.id`, `snapshots.branch_id → branches.id`) — that
  was wrong. `branches.forkedFromSnapshotId` and `snapshots.parentSnapshotId` are both plain
  columns with no `.references()` at all (verified against `schema.ts` directly); the only real
  FK is `snapshots.branchId → branches.id`, one direction, no cycle. There was never anything to
  fear here.
- **PLAN-FLOW-VERSIONING.md landed in full (S1–S6): dedup/provenance, `diffGraphs`, version
  history + restore + pins, retention GC, and a read-only git tab.** The single most surprising
  discovery, and the one future schema work on `flow_versions` needs to remember:
  - **`content_hash` had a DB-level `UNIQUE(flow_id, content_hash)` index from the DSL work
    (migration 0003) — restore's own locked decision ("creates a NEW version," §3) is
    incompatible with it, and this only surfaces once you actually try to restore a version whose
    content happens to duplicate another one.** Restoring an old graph identical to some existing
    revision, deduped the normal way, just hands back that OLD row — HEAD (defined as "the row
    with the highest `version` number") doesn't move, silently turning "restore" into a no-op from
    the user's point of view. Fixed by **relaxing the constraint to a plain non-unique index**
    (migration 0005, `flow_versions_content_idx`) and moving dedup enforcement entirely into
    `saveFlowVersion`'s own SELECT-before-insert — a new `opts.force: true` skips that SELECT and
    always inserts, which is exactly what `POST /api/flows/:id/restore` passes. Any code that
    still assumes content_hash is unique per flow (there was exactly one such assumption —
    `backfillContentHashes`'s duplicate-collapsing, which now includes an explicit "don't assign a
    hash that's already taken" clash-check rather than relying on the DB to reject it) needs to
    keep doing its own uniqueness bookkeeping.
  - **`content_hash` is now *always* populated** (`computeContentHash` in `persistence/src/
    flows.ts`), not null whenever `sourceText` is omitted — it falls back to
    `sha256(canonicalGraphJson(graph))` (`@flowlathe/core`'s new `canonical.ts`) so a DB-only save
    (no `.flow` file involved — today, just `@flowlathe/cli`'s `flows import`, which was also
    fixed here to actually pass its DSL text through as `sourceText` like every other save path
    already did) still dedups instead of accumulating one row per identical save. This is a real
    behavior change from pre-this-plan: `packages/cli/src/commands/flows.test.ts`'s "importing
    the same flow again" test used to assert an unconditional version bump and had to be rewritten
    to assert dedup instead.
  - **`parent_version_id` defaults to whatever was HEAD immediately before the insert, NOT
    necessarily `version - 1`** — `saveFlowVersion`'s `opts.parentVersionId` override is what
    restore uses to record the *restored-from* version as the parent instead, which is what makes
    history a tree (a node whose parent is far older than its own immediate predecessor) rather
    than a flat list, exactly as §3 intends.
  - **`diffGraphs` matches edges by their `(source, sourceHandle, target, targetHandle)` tuple, not
    by `id`** — edge ids are caller-assigned and the DSL round-trip canonicalizes them on every
    parse (see this file's own `canonicalEdgeId` note under PLAN-FLOW-DSL.md), so two structurally
    identical graphs can disagree on edge ids for no semantic reason. A consequence worth knowing:
    a target-handle change on "the same" edge shows up as one `removed` + one `added` entry, not a
    `changed` one — `GraphDiff.edges` has no `changed` field at all, deliberately.
  - **A reparent (`FlowNode.parentId` changing) is unconditionally a semantic change in
    `isSemanticChange`, even with zero field changes** — a node moving into or out of a Loop/Map
    body changes what actually runs, unlike a pure position move (`movedTo`), which is the one
    kind of "changed" entry `isSemanticChange` ignores.
  - **Triggers still pin directly via `triggers.flowVersionId`, not through the new generic
    `flow_pins` table** — that mechanism predates this plan (PLAN-INTEGRATIONS.md) and already
    satisfies "never follow HEAD" on its own. `flow_pins(flow_id, channel, flow_version_id)` exists
    for channels with no dedicated row of their own (starts with one manually-triggered `"default"`
    channel from the canvas's version-history dialog); it is NOT a replacement for the trigger
    mechanism and nothing reconciles the two. Retention GC's guard set checks both
    `triggers.flowVersionId` and `flowPins.flowVersionId` (plus `executions.flowVersionId`)
    independently — see `flow-version-gc.ts`.
  - **Reloading a flow's graph (`loadFlow`, `handleRestore`, "Reload from disk") replaces xyflow's
    node objects wholesale, which drops each node's `selected` flag and fires
    `onSelectionChange([])`** — `Canvas.tsx`'s `selectedNodeId` goes back to `null` any time this
    happens, even though the node itself still exists with the same id. Not a bug (nothing in this
    codebase promised selection survives a full graph reload), but it means a Playwright spec that
    reloads/restores and then immediately reads the node-properties panel needs to re-click the
    node first — `slice9-flow-versioning.spec.ts` does this after its restore step.
  - **Playwright's `getByRole(role, {name})` does substring matching by default, not exact** — a
    toolbar button literally labeled "Save as version…" would have made every existing
    `getByRole("button", {name: "Save"})` locator (several prior slice specs use exactly this)
    ambiguous/strict-mode-violating the moment both buttons are on screen together, which is
    always, since neither is conditionally rendered. Named it "Name version…" instead. Any new
    always-visible button whose label is a superstring of an existing one's name will hit the same
    trap.
  - **No Playwright e2e spec for the git-history tab (S6)** — same rationale CLAUDE.md already
    records for SearXNG/Firecrawl/MCP: standing up a real git repo inside the e2e harness's
    per-run temp `flowsDir` is a separable piece of work from the feature itself, and
    `packages/server/src/git-history.ts`'s own tests already exercise `git init`/`commit`/`show`
    for real (no mocking) end-to-end through the HTTP routes
    (`routes/flows-versioning.test.ts`'s "git history (Layer 2, S6)" block). Left as a tracked gap,
    not a hidden one.
- **PLAN-EXECUTION-RETENTION.md landed execution-history retention and mark-and-sweep blob GC**
  (`deleteExecution`/`gcExecutions`/`gcFlowHistory` in `@flowlathe/persistence`, a boot+24h server
  timer, and `flowlathe gc`). Two things worth knowing before touching any of this:
  - **A snapshot's blob refs are not FKs.** `snapshots.payload_json` embeds
    `{kind:"value", ref:"<sha>"}` entries (`stepper.ts:28`) that no FK column tracks — the eighth,
    invisible root of the blob-liveness graph. `collectSnapshotBlobRefs`
    (`packages/persistence/src/execution-gc.ts`) is the single source of truth for "what refs does
    a snapshot payload contain"; it's used both to find candidates when an execution is deleted and
    to subtract still-alive refs from a surviving execution's payload before the sweep runs. Any
    code that ever needs to reason about blob liveness must go through it — a second, hand-rolled
    walker would inevitably drift from this one in the fatal direction (finding fewer refs than it
    should, i.e. treating a live blob as dead).
  - **`SqliteBlobStore.put()` (`packages/persistence/src/sqlite-blob-store.ts`) produces an
    unrooted blob** — nothing but content-addressing ties it to anything GC can see. Because blobs
    are content-addressed, `put()`-ing bytes identical to a value some execution already owns
    returns the *same row*, and deleting that execution collects it out from under the unrelated
    caller that also holds that sha — pinned as expected (not a bug) by
    `execution-gc.test.ts`'s "unrooted blob" case. The first real caller of `put()` beyond tests
    should either root the returned sha in a row GC can see, or this liveness check needs an
    explicit exemption.
