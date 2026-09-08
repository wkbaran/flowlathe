# FIX-EXECUTION-RETENTION — execution history and blob reclamation

Status: not started. Own session. Needs real design work before any code.

Source: security/bug audit, finding #10 (plus the `deserializeSnapshot` silent-`""` fallback).

## 1. The problem, stated accurately

`releaseBlob` (`packages/persistence/src/blobs.ts:29`) is **called from nowhere in the repo**.
Verified by grep: the only occurrences of `refcount` are its schema declaration, the `+ 1` in
`putBlob`, and the `- 1` in `releaseBlob` itself. The refcount machinery was designed and never
wired up.

But blob GC is the *second* problem, not the first. The first is bigger:

**Nothing in this codebase ever deletes an execution, branch, snapshot, step, response, or run
event.** The only `db.delete(...)` calls that exist anywhere in `@flowlathe/persistence` are:

| File | Deletes |
| --- | --- |
| `flow-version-gc.ts:64,65` | `state_decls`, `flow_versions` |
| `providers.ts:106` | `providers` |
| `models.ts:43` | `models` |
| `flow-pins.ts:48` | `flow_pins` |
| `plugin-credentials.ts:23` | `plugin_credentials` |
| `triggers.ts:61` | `triggers` |

So execution history is append-only forever. Every step of every run writes a blob per port value
(`stepper.ts`'s `serializeSnapshot` → `putBlob`), plus a `responses` row with up to three blob
refs, plus `run_events` rows. A long-lived server — especially one with a Discord trigger firing
on every channel message — grows without bound, and blob GC has no upstream trigger point to hang
off because nothing upstream is ever deleted.

**Do not start by writing `releaseBlob` call sites.** Start by deciding what retention means for
an execution. Blob reclamation falls out of that decision; it does not stand alone.

## 2. What makes this non-trivial

### 2.1 Snapshot blob refs are invisible to the schema

Seven columns carry a real FK to `blobs.sha256`:

| Table | Column |
| --- | --- |
| `messages` | `content_sha` |
| `responses` | `rendered_prompt_sha`, `thinking_sha`, `content_sha` |
| `tool_calls` | `result_sha` |
| `state_writes` | `value_sha` |
| `execution_triggers` | `payload_sha` |

`snapshots` is **not** in that list. A snapshot's blob references live *inside* its opaque JSON
`payload` column, as `{kind:"value", ref:"<sha>"}` entries produced by `serializeSnapshot`
(`packages/server/src/stepper.ts:28`). Any mark-and-sweep pass therefore cannot discover snapshot
references by walking foreign keys — it has to parse every snapshot payload. Any refcount scheme
has to be driven from `serializeSnapshot`/snapshot-deletion by hand.

This is the single most likely source of a silent data-loss bug in this work: a GC that walks FKs
only will happily delete every blob a step-debug session depends on.

### 2.2 Blobs are content-addressed and shared

`putBlob` is `onConflictDoUpdate` on `sha256` with `refcount + 1`. Identical port values across
different executions, branches, and iterations collapse to one row. Deleting an execution must not
delete a blob another execution still references — which is exactly what the refcount was for, and
exactly what has been silently wrong the whole time (increments happened, decrements never did, so
existing refcounts are *overcounts* of nothing in particular).

### 2.3 Existing rows have meaningless refcounts

Any refcount-based design needs a migration that recomputes every blob's refcount from actual
references, or the scheme starts from garbage. A mark-and-sweep design sidesteps this entirely.

## 3. Decisions to make (in this order)

1. **What is the retention unit?** Per-execution (delete a whole execution and everything under
   it) is the obvious answer, but check whether a branch or a snapshot ever needs to be reclaimed
   independently — step mode creates a snapshot per step, and a long debugging session on one
   execution can be the actual growth driver.
2. **What is the retention policy?** Options: keep the N most recent executions per flow; keep
   anything newer than T; keep everything not referenced by a pin/trigger; explicit
   user-initiated delete only. Whatever you pick, it needs a guard set analogous to
   `flow-version-gc.ts`'s (`triggers.flowVersionId`, `flowPins.flowVersionId`,
   `executions.flowVersionId`) — note that `gcFlowVersions` currently treats a live execution as a
   *reason to keep a flow version*, so execution GC and flow-version GC now interact in both
   directions. Work out that ordering explicitly.
3. **Refcount or mark-and-sweep?** Recommendation: **mark-and-sweep**, run after execution
   deletion. It needs no migration, tolerates the historical refcount garbage, and is robust to a
   missed decrement — at the cost of a full scan. Given a single-user local SQLite database, the
   scan cost is almost certainly irrelevant, and correctness here is worth much more than speed.
   If you choose mark-and-sweep, decide what to do with the `refcount` column: drop it in a
   migration, or leave it in place and stop pretending it means anything (document which).
4. **Who triggers it?** Boot-time, a background timer, on execution completion, or an explicit
   API/CLI command. A local server that is frequently restarted makes boot-time attractive and
   cheap to reason about.

## 4. Related bug to fix in the same pass

`deserializeSnapshot` (`packages/server/src/stepper.ts:50`) substitutes `""` for a blob it can't
find:

```ts
outSlots[port] = { kind: "value", value: bytes ? bytes.toString("utf-8") : "" };
```

Today that path is unreachable (nothing deletes blobs). The moment GC exists, it becomes the
failure mode for a GC bug — and it fails *silently*, resuming a step with an empty input instead
of erroring. Change it to throw before shipping any GC.

## 5. Definition of done

- A documented, tested retention policy with an explicit guard set.
- Deleting an execution removes its branches, snapshots, steps, responses, run events, state
  reads/writes, tool calls, messages, and execution-trigger claims — with a test asserting no
  orphan rows remain in any of them.
- A blob reclamation pass with a test proving a blob shared by two executions survives deleting
  one of them, and a test proving a snapshot-payload-only reference (no FK) is honoured.
- Migration for existing databases, whichever scheme is chosen.
- `deserializeSnapshot` throws on a missing blob.
- A note in `CLAUDE.md` recording the snapshot-payload-refs-are-not-FKs trap for the next agent.
