<!--
Handoff document. Written for an implementing agent picking this up cold.

- "Locked decisions" were settled with the project owner. Don't relitigate them.
- Read PLAN.md (architecture source of truth) and CLAUDE.md (surprises log) first.
- Layer 1 (§4) works against today's DB-backed flows and can ship on its own.
  Layer 2 (§5) assumes PLAN-FLOW-DSL.md has landed. Build Layer 1 first either way — Layer 2
  is additive to it, not a replacement.
-->

# Implementation plan — flow versioning

**Status:** done (S1–S6 all landed). No Playwright e2e spec for the git-history tab (S6) — see
CLAUDE.md; covered instead by `packages/server/src/git-history.test.ts` and
`routes/flows-versioning.test.ts`'s git-history block, both against a real git repo.
**Related:** `PLAN-FLOW-DSL.md` (flows become files; §5 here depends on it),
`PLAN-INTEGRATIONS.md` (a Discord trigger must run a *pinned* version, §6 here).

---

## 1. The problem

flowlathe already has a `flow_versions` table, and it is nearly meaningless to a user.

`saveFlowVersion` (`packages/persistence/src/flows.ts:74`) inserts a new row on **every** save,
unconditionally:

```ts
const version = (latest?.version ?? 0) + 1;
db.insert(flowVersions).values({ id: randomUUID(), flowId, version, graphJson: graph }).run();
```

`Canvas.tsx` calls `PUT /api/flows/:id` from `handleSave`, and `handleRun`/`handleStep` each call
`handleSave()` first (CLAUDE.md, "safe to check against live state"). So a single debugging session
that runs a flow ten times produces ten "versions" of an unchanged graph. Concretely, today:

- **Versions are noise, not milestones.** No label, no message, no way to tell version 47 from 46.
- **Nothing is deduplicated.** An unchanged graph still increments the counter.
- **There is no history UI at all.** Versions exist only as an FK target.
- **There is no diff.** "What changed between the run that worked and the one that didn't" — the
  single most valuable question a step-debugger's user asks — is unanswerable.
- **There is no restore.** You cannot get an earlier graph back.
- **Provenance is invisible.** `executions.flow_version_id` records which graph ran, and the UI
  never shows it.
- **Step mode deliberately follows HEAD.** `getLatestGraphForFlowVersion`
  (`packages/persistence/src/flows.ts:58`) resolves the flow's *latest* version so "step back, edit a
  prompt, step forward" picks up the edit (CLAUDE.md). That is the right behavior and it is
  completely undisclosed in the UI — a user who edits a node mid-session has no signal that the
  running execution's graph just changed underneath it.
- **Nothing can be pinned.** Any future scheduled or triggered execution would follow HEAD, so
  editing a node on the canvas would silently change what a live bot does.

So: the plumbing is right (immutable rows, an FK from every execution) and the product is absent.

---

## 2. Locked decisions

| Decision | Choice | Why |
|---|---|---|
| History model | **Immutable, append-only. Restore creates a new version** | Same discipline as execution branches: `stepBack` retains the old branch and never truncates (PLAN.md). Rewriting history would break `executions.flow_version_id` |
| Autosave vs. milestone | **Two tiers in one table**: unnamed revisions (autosaved, GC-able) and named versions (labeled, never GC-able) | Every save must still be recoverable; only some saves are milestones |
| Dedup | **Content hash.** An identical graph creates no new row | Fixes version inflation at the source rather than filtering it in the UI |
| Diff | **One structural primitive in `@flowlathe/core`**, consumed by the UI, the CLI, and the execution view | The `plugin-deps.ts` / `regions.ts` precedent: one primitive, many consumers — never three ad hoc diffs |
| Step mode | **Keeps following HEAD, but says so** | The behavior is correct and deliberate; the invisibility is the bug |
| Triggers/deployments | **Pin an explicit version.** Never HEAD | Editing the canvas must not mutate production behavior |
| Git | **Not reimplemented.** Once flows are files, the user's git is the version store; flowlathe reads it, optionally, read-only | Building a VCS is not this project's job |

---

## 3. What a "version" should mean

Three distinct things are conflated today. Separate them:

1. **Revision** — an immutable content-addressed snapshot of a graph. Created on save (when content
   actually changed) and on run/step-start. Cheap, numerous, garbage-collectable.
2. **Named version** — a revision a human labeled ("baseline", "with-reranker", "v2 for demo").
   Never collected. This is what people mean by "version."
3. **Pin** — a named pointer some consumer follows (a trigger, a scheduled run, an exported
   deployment). Points at a revision, changes only by explicit action.

---

## 4. Layer 1 — works against today's DB-backed flows

### 4.1 Schema

```sql
ALTER TABLE flow_versions ADD COLUMN content_hash    TEXT;      -- sha256 of canonical graph JSON
ALTER TABLE flow_versions ADD COLUMN label           TEXT;      -- NULL = unnamed revision
ALTER TABLE flow_versions ADD COLUMN message         TEXT;      -- optional description
ALTER TABLE flow_versions ADD COLUMN parent_version_id TEXT;    -- the version this was saved from
CREATE UNIQUE INDEX flow_versions_content ON flow_versions(flow_id, content_hash);

CREATE TABLE flow_pins (
  flow_id         TEXT NOT NULL,
  channel         TEXT NOT NULL,        -- 'default' | 'trigger' | future deployment channels
  flow_version_id TEXT NOT NULL REFERENCES flow_versions(id),
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (flow_id, channel)
);
```

Generate the migration with `drizzle-kit generate` after editing
`packages/persistence/src/schema.ts` — do not hand-write it (CLAUDE.md's note on the schema being
generated whole).

**`content_hash` must be over a canonical serialization.** `JSON.stringify` of a `FlowGraph` is
key-order- and array-order-dependent, so a canvas re-render that reorders `nodes` would look like a
change. Add `canonicalGraphJson(graph)` to `@flowlathe/core` (sort nodes by id, edges by
`(source, sourceHandle, target, targetHandle)`, state decls by name, and object keys recursively)
and hash that. Once `PLAN-FLOW-DSL.md` lands, the canonical DSL text is a better hash input and
`canonicalGraphJson` becomes the fallback for DB-only flows — the interface stays the same.

**Backfill:** the migration computes `content_hash` for existing rows and collapses exact duplicates
that no execution references. Rows an execution points at are always kept, even when duplicated.

### 4.2 `saveFlowVersion` becomes content-aware

```
save(flowId, graph, {label?, message?}):
  hash = sha256(canonicalGraphJson(graph))
  existing = SELECT ... WHERE flow_id = ? AND content_hash = hash
  if existing and no label requested:  return existing        # no new row
  if existing and label requested:     set label/message on existing; return it
  else insert {version: max+1, content_hash: hash, parent_version_id: <caller's loaded version>}
```

`parent_version_id` is what makes history a tree rather than a list — it matters as soon as a user
restores an old version and continues from it, and it is free to record now.

This alone removes most of the noise: a ten-run debugging session on an unchanged graph produces one
row, not ten.

### 4.3 Retention

Unnamed revisions accumulate. GC rule, run on save (cheap, bounded):

> Delete unnamed revisions of this flow that are (a) not the current HEAD, (b) not referenced by any
> `executions.flow_version_id`, (c) not referenced by `flow_pins`, (d) not among the newest `K`
> (default 50), and (e) older than `D` days (default 30).

`state_decls` rows FK to `flow_versions` and must be deleted with the row. Every other reference is
covered by (b)/(c). Make `K`/`D` env-configurable and default them generously — disk is cheap and a
lost revision is unrecoverable.

### 4.4 Structural diff — one primitive

New `packages/core/src/diff.ts`:

```ts
export interface GraphDiff {
  nodes: {
    added:   FlowNode[];
    removed: FlowNode[];
    changed: { id: string; kind: NodeKind; fields: FieldChange[]; movedTo?: Position; reparented?: {from?: string; to?: string} }[];
  };
  edges: { added: FlowEdge[]; removed: FlowEdge[] };
  state: { added: StateDecl[]; removed: StateDecl[]; changed: { name: string; fields: FieldChange[] }[] };
}
export interface FieldChange { path: string; before: unknown; after: unknown }
export function diffGraphs(before: FlowGraph, after: FlowGraph): GraphDiff;
export function isSemanticChange(diff: GraphDiff): boolean;  // false when only positions moved
```

Rules that make it useful rather than merely correct:

- **Match nodes by id**, never by position or index. Node ids are stable across edits (CLAUDE.md) —
  that is precisely what makes a diff meaningful here.
- **Position-only changes are separated** (`movedTo`) and excluded from `isSemanticChange`. Someone
  tidying the canvas has not changed the flow, and the UI should say "layout only."
- **Multi-line string fields diff by line** (prompt templates are the main payload of a real change);
  everything else diffs by value.
- Consumers: the version-history UI, `flowlathe check`/`diff` in the CLI, the execution detail view
  ("this run's graph vs. current"), and the step-mode staleness indicator (§4.6).

### 4.5 API and UI

```
GET    /api/flows/:id/versions                 -> [{id, version, label, message, contentHash, createdAt, isHead, executionCount}]
GET    /api/flows/:id/versions/:versionId      -> {graph, label, message, ...}
POST   /api/flows/:id/versions/:versionId/label -> {label, message}      (name an existing revision)
GET    /api/flows/:id/diff?from=&to=           -> GraphDiff
POST   /api/flows/:id/restore                  -> {versionId}   creates a NEW head equal to that graph
GET    /api/flows/:id/pins  |  PUT /api/flows/:id/pins/:channel
```

Canvas UI:

- A **version history drawer**: newest first, named versions visually distinct, each row showing
  "N nodes changed" from its parent and how many executions ran it. Select two rows → diff view.
- A **diff view**: per-node change list with template changes rendered as a line diff. Read-only.
- **"Save as version…"** next to Save — label + message. Plain Save keeps creating unnamed revisions.
- **Restore** on a history row: loads that graph onto the canvas as unsaved changes, so the user
  reviews before saving. Saving creates a *new* head; history is never rewritten.

Execution views:

- Show which version ran, by label when it has one, with a link to view that graph read-only.
- On an execution whose flow has since changed, a one-line "flow has changed since this run
  (3 nodes)" with a link to the diff.

### 4.6 Making step mode's HEAD-following visible

Keep the behavior; add the signal. When a step session's `flow_version_id` no longer matches the
flow's current head **and** `isSemanticChange(diff)` is true, the canvas shows a persistent chip:

> Stepping against the current graph — 2 nodes changed since this session started. [view diff]

This is the honest surface for a deliberate design decision that currently looks like a bug the first
time it bites someone. Cheap: the data is already on both sides of the API.

---

## 5. Layer 2 — once flows are files (`PLAN-FLOW-DSL.md`)

With flows as `flows/*.flow`, the *definition's* history belongs to git, and flowlathe should not
compete with it.

- **Do not shell out to git to write anything.** No auto-commit, no auto-branch. The user's repo is
  theirs.
- **Optionally read it.** When `FLOWLATHE_FLOWS_DIR` is inside a git work tree, the version-history
  drawer gains a "git" tab backed by a read-only `git log --follow -- <file>` and
  `git show <rev>:<file>`. Each commit is parsed into a `FlowGraph` and fed to the *same*
  `diffGraphs` primitive, so the structural diff view works over commits with no new code. Absent
  git, or outside a work tree, the tab simply doesn't render.
- **`flow_versions` keeps its Layer-1 job unchanged**: an immutable, content-addressed record of what
  actually ran, including uncommitted working-tree edits — which git cannot provide, and which
  execution provenance requires. `source_text` (added in the DSL plan) is what lets an execution
  render its exact flow text long after the file moved on.
- **Named versions and git tags stay separate.** Do not try to sync them; one is flowlathe's record
  of a milestone graph, the other is the user's repo convention.

Net effect: after Layer 2, "flow versioning" for a user is *git*, and flowlathe's own version table
quietly guarantees that every execution can still show precisely what it ran.

---

## 6. Pinning (what `PLAN-INTEGRATIONS.md` needs)

`flow_pins(flow_id, channel, flow_version_id)` from §4.1 exists for one reason: a Discord trigger —
or any future scheduled run — must not follow HEAD. Editing a prompt on the canvas cannot be allowed
to change what a live bot does mid-sentence.

- `triggers.flow_version_id` is NOT NULL and set from the `trigger` pin at registration time.
- The trigger UI shows the pinned version and offers "update to current" as an explicit action, with
  the diff shown before confirming.
- A pinned version is never GC-able (§4.3, rule (c)).

---

## 7. Testing

- **Persistence**: saving an unchanged graph creates no row; saving a changed graph increments
  `version` and sets `parent_version_id`; labeling an existing revision doesn't duplicate it;
  `canonicalGraphJson` is order-insensitive (shuffle nodes/edges → same hash); GC never deletes a
  named, HEAD, pinned, or execution-referenced revision, and cascades `state_decls`.
- **`diffGraphs` unit tests**: added/removed/changed nodes; per-field changes; template line diff;
  position-only change ⇒ `isSemanticChange === false`; `parentId` reparent detected (a node moved
  into or out of a Loop/Map body is a real semantic change and easy to miss);
  edge handle change detected.
- **Migration**: backfills `content_hash`, collapses only unreferenced duplicates, leaves every
  execution's FK resolvable. Test against a DB seeded with duplicate rows in the current shape.
- **Server**: restore creates a new head rather than mutating; `/diff` rejects version ids from a
  different flow; a pinned version survives GC.
- **E2E** (`playwright/`): edit a flow, save as a named version, edit again, open history, diff the
  two, restore the first, assert a new head exists **and** the intermediate version is still listed —
  the exact shape of Slice 4's existing branch-fork spec, applied to flow history.
- **Step-mode staleness**: start a step session, edit a node's template, save, assert the staleness
  chip appears and the session still steps against the edited graph (the behavior CLAUDE.md
  documents must not regress).

---

## 8. Slices

**S1 — dedup + provenance.** `content_hash`, `canonicalGraphJson`, `parent_version_id`,
content-aware `saveFlowVersion`, migration + backfill. No UI. Immediately removes version inflation.

**S2 — `diffGraphs`.** The core primitive plus its tests. No UI. Consumed next.

**S3 — history, naming, diff, restore.** The API surface in §4.5 and the canvas drawer/diff view;
"Save as version…"; execution views showing which version ran; the step-mode staleness chip.

**S4 — retention.** GC with its guards, configurable `K`/`D`, plus the "N revisions collected" log
line so it is never silent.

**S5 — pinning.** `flow_pins`, the pin UI, and the trigger integration from `PLAN-INTEGRATIONS.md`.

**S6 — git tab** (requires `PLAN-FLOW-DSL.md`). Read-only `git log`/`git show` over the flow file,
reusing `diffGraphs`.

---

## 9. Design traps

1. **Non-canonical hashing makes dedup useless.** If the canvas ever reorders `nodes` (React state
   churn, a node deleted and re-added), a naive `JSON.stringify` hash differs for an identical graph
   and the version count inflates again — with the bug now hidden behind a mechanism that looks like
   it works.
2. **Restore must not rewrite history.** `executions.flow_version_id` is a NOT NULL FK; deleting or
   mutating a version an execution points at breaks the debugging history this project is built
   around.
3. **GC's guard list is load-bearing.** Every one of named / HEAD / pinned / execution-referenced
   protects against a real data-loss path. Add the tests before the deletion code.
4. **Position-only diffs will otherwise dominate.** Without `isSemanticChange`, every history entry
   reads "changed" because someone dragged a node, and the feature becomes noise — the same failure
   mode as today's version inflation, one level up.
5. **Don't auto-commit to the user's git repo.** Ever. Read-only, or not at all.
6. **A pin that silently follows HEAD is worse than no pin.** If the trigger work lands before §6,
   make triggers *refuse* to register rather than defaulting to HEAD.

---

## 10. Definition of done

- [x] `canonicalGraphJson` in `@flowlathe/core`, order-insensitive, unit-tested.
- [x] `flow_versions` carries `content_hash`, `label`, `message`, `parent_version_id`; migration
      generated by `drizzle-kit generate` and backfilled safely. (`content_hash` ended up a plain
      non-unique index rather than "unique per flow" as originally written here — restore's own
      "creates a NEW version" requirement is incompatible with a hard uniqueness constraint; see
      CLAUDE.md for why and how dedup is enforced instead.)
- [x] `saveFlowVersion` deduplicates; an unchanged save creates no row; labeling is idempotent.
- [x] `diffGraphs` + `isSemanticChange` in `@flowlathe/core`, with reparent, handle-change, and
      template-line-diff coverage.
- [x] Version history API + canvas drawer, diff view, "Save as version…", restore-as-new-head.
- [x] Execution views name the version they ran and link to a read-only graph and a diff vs. current.
- [x] Step-mode staleness chip, with a test that the underlying HEAD-following behavior is unchanged.
- [x] Retention GC with all four guards, configurable, logged.
- [x] `flow_pins` + pin UI; triggers pin explicitly and never follow HEAD.
- [x] (After the DSL plan) read-only git history tab reusing `diffGraphs`.
- [x] README section on what a version is (revision vs. named version vs. pin); `CLAUDE.md` updated.
