import { and, asc, eq, gt, inArray, notExists, sql } from "drizzle-orm";
import { withTransaction, type Db } from "./db.js";
import {
  blobs,
  branches,
  contextMessages,
  contextTransformCalls,
  contexts,
  executionTriggers,
  executions,
  flows,
  messages,
  responses,
  runEvents,
  snapshots,
  stateReads,
  stateWrites,
  steps,
  toolCalls,
} from "./schema.js";
import { listExecutionsForFlow } from "./executions.js";
import { gcFlowVersions, type FlowVersionGcOptions } from "./flow-version-gc.js";

const BATCH_SIZE = 500;

/** Every blob sha reachable inside a snapshot's opaque `payload_json`. Walks the whole tree for
 *  any object with a string `ref`, rather than assuming the current
 *  `{outputs:{node:{port:slot}}}` shape — if `serializeSnapshot`
 *  (packages/server/src/stepper.ts:28) ever nests refs somewhere else, this keeps finding them.
 *  Over-collecting keeps a blob alive; under-collecting deletes live data. Always over-collect. */
export function collectSnapshotBlobRefs(payload: unknown, into: Set<string>): Set<string> {
  if (payload === null || payload === undefined || typeof payload !== "object") return into;
  if (Array.isArray(payload)) {
    for (const item of payload) collectSnapshotBlobRefs(item, into);
    return into;
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj["ref"] === "string") into.add(obj["ref"]);
  for (const value of Object.values(obj)) collectSnapshotBlobRefs(value, into);
  return into;
}

export interface DeleteExecutionResult {
  executionId: string;
  rowsDeleted: number;
  blobsDeleted: number;
  bytesReclaimed: number;
}

/** Pages through every remaining snapshot (ordered by id, `BATCH_SIZE` at a time), removing any
 *  sha its payload still references from `candidates` — those blobs are still alive. Deliberately
 *  a TS walk, not `json_tree(payload_json)`: two implementations of "what refs does a snapshot
 *  payload contain" would diverge asymmetrically in the fatal direction (a ref the walker finds
 *  but the SQL misses looks dead and gets deleted). Stops early once nothing is left to check. */
function subtractSurvivingSnapshotRefs(db: Db, candidates: Set<string>): void {
  if (candidates.size === 0) return;
  let lastId = "";
  for (;;) {
    const page = db
      .select({ id: snapshots.id, payload: snapshots.payloadJson })
      .from(snapshots)
      .where(lastId ? gt(snapshots.id, lastId) : undefined)
      .orderBy(asc(snapshots.id))
      .limit(BATCH_SIZE)
      .all();
    if (page.length === 0) break;
    for (const row of page) {
      const found = collectSnapshotBlobRefs(row.payload, new Set());
      for (const sha of found) candidates.delete(sha);
      if (candidates.size === 0) return;
    }
    lastId = page[page.length - 1]!.id;
    if (page.length < BATCH_SIZE) break;
  }
}

/** Deletes every candidate sha with no remaining FK pointing at it, in batches of `BATCH_SIZE`.
 *  Three separate `NOT EXISTS` clauses for `responses`' three blob columns, not one `OR` — an
 *  `OR` across columns can't use a single-column index and degrades to a full scan per candidate.
 *  An explicit `NOT EXISTS` chain, not "try the delete and catch the FK error", since the latter
 *  would abort the whole enclosing transaction on the first live blob. */
function sweepDeadBlobs(db: Db, candidates: Set<string>): { blobsDeleted: number; bytesReclaimed: number } {
  if (candidates.size === 0) return { blobsDeleted: 0, bytesReclaimed: 0 };
  const shas = [...candidates];
  let blobsDeleted = 0;
  let bytesReclaimed = 0;
  for (let i = 0; i < shas.length; i += BATCH_SIZE) {
    const batch = shas.slice(i, i + BATCH_SIZE);
    const dead = db
      .select({ sha: blobs.sha256, byteLen: blobs.byteLen })
      .from(blobs)
      .where(
        and(
          inArray(blobs.sha256, batch),
          notExists(db.select({ x: sql`1` }).from(messages).where(eq(messages.contentSha, blobs.sha256))),
          notExists(db.select({ x: sql`1` }).from(responses).where(eq(responses.renderedPromptSha, blobs.sha256))),
          notExists(db.select({ x: sql`1` }).from(responses).where(eq(responses.thinkingSha, blobs.sha256))),
          notExists(db.select({ x: sql`1` }).from(responses).where(eq(responses.contentSha, blobs.sha256))),
          notExists(db.select({ x: sql`1` }).from(toolCalls).where(eq(toolCalls.resultSha, blobs.sha256))),
          notExists(db.select({ x: sql`1` }).from(stateWrites).where(eq(stateWrites.valueSha, blobs.sha256))),
          notExists(db.select({ x: sql`1` }).from(executionTriggers).where(eq(executionTriggers.payloadSha, blobs.sha256))),
        ),
      )
      .all();
    if (dead.length === 0) continue;
    bytesReclaimed += dead.reduce((sum, r) => sum + r.byteLen, 0);
    const deadShas = dead.map((r) => r.sha);
    blobsDeleted += db.delete(blobs).where(inArray(blobs.sha256, deadShas)).run().changes;
  }
  return { blobsDeleted, bytesReclaimed };
}

/**
 * Deletes one execution and everything scoped to it — 14 tables, child-first, inside one
 * transaction — then sweeps any blob that was only alive because of this execution's own rows.
 * Nothing outside this subtree ever points at an execution (`grep '.references(() =>
 * executions.id)'` yields exactly `branches`, `contexts`, `responses`, `run_events`,
 * `execution_triggers` — no `flow_pins`, `triggers`, or `flow_versions` row ever does), so this
 * is safe to call standalone. Idempotent: deleting an id twice is a no-op, not a throw.
 */
export function deleteExecution(db: Db, executionId: string): DeleteExecutionResult {
  return withTransaction(db, () => {
    let rowsDeleted = 0;

    const branchIds = db.select({ id: branches.id }).from(branches).where(eq(branches.executionId, executionId)).all().map((r) => r.id);
    const responseIds = db.select({ id: responses.id }).from(responses).where(eq(responses.executionId, executionId)).all().map((r) => r.id);
    const contextIds = db.select({ id: contexts.id }).from(contexts).where(eq(contexts.executionId, executionId)).all().map((r) => r.id);

    // Phase A — collect candidate blob shas (and the message ids that name them) before
    // deleting anything; the join paths used here are destroyed in Phase B.
    const candidates = new Set<string>();
    for (const row of db.select({ sha: responses.renderedPromptSha }).from(responses).where(eq(responses.executionId, executionId)).all())
      if (row.sha) candidates.add(row.sha);
    for (const row of db.select({ sha: responses.thinkingSha }).from(responses).where(eq(responses.executionId, executionId)).all())
      if (row.sha) candidates.add(row.sha);
    for (const row of db.select({ sha: responses.contentSha }).from(responses).where(eq(responses.executionId, executionId)).all())
      if (row.sha) candidates.add(row.sha);
    if (responseIds.length > 0) {
      for (const row of db.select({ sha: toolCalls.resultSha }).from(toolCalls).where(inArray(toolCalls.responseId, responseIds)).all())
        if (row.sha) candidates.add(row.sha);
    }
    if (branchIds.length > 0) {
      for (const row of db.select({ sha: stateWrites.valueSha }).from(stateWrites).where(inArray(stateWrites.branchId, branchIds)).all())
        candidates.add(row.sha);
    }
    let messageIds: string[] = [];
    if (contextIds.length > 0) {
      messageIds = db
        .select({ messageId: contextMessages.messageId })
        .from(contextMessages)
        .where(inArray(contextMessages.contextId, contextIds))
        .all()
        .map((r) => r.messageId);
      if (messageIds.length > 0) {
        for (const row of db.select({ sha: messages.contentSha }).from(messages).where(inArray(messages.id, messageIds)).all())
          candidates.add(row.sha);
      }
    }
    for (const row of db.select({ sha: executionTriggers.payloadSha }).from(executionTriggers).where(eq(executionTriggers.executionId, executionId)).all())
      candidates.add(row.sha);
    if (branchIds.length > 0) {
      for (const row of db.select({ p: snapshots.payloadJson }).from(snapshots).where(inArray(snapshots.branchId, branchIds)).all())
        collectSnapshotBlobRefs(row.p, candidates);
    }

    // Phase B — delete rows, child-first.
    if (responseIds.length > 0) rowsDeleted += db.delete(toolCalls).where(inArray(toolCalls.responseId, responseIds)).run().changes;
    rowsDeleted += db.delete(responses).where(eq(responses.executionId, executionId)).run().changes;
    if (contextIds.length > 0) {
      rowsDeleted += db
        .delete(contextTransformCalls)
        .where(
          sql`${contextTransformCalls.sourceContextId} IN ${contextIds} OR ${contextTransformCalls.resultContextId} IN ${contextIds}`,
        )
        .run().changes;
      rowsDeleted += db.delete(contextMessages).where(inArray(contextMessages.contextId, contextIds)).run().changes;
    }
    if (messageIds.length > 0) {
      rowsDeleted += db
        .delete(messages)
        .where(
          and(
            inArray(messages.id, messageIds),
            notExists(db.select({ x: sql`1` }).from(contextMessages).where(eq(contextMessages.messageId, messages.id))),
          ),
        )
        .run().changes;
    }
    if (branchIds.length > 0) {
      rowsDeleted += db.delete(stateWrites).where(inArray(stateWrites.branchId, branchIds)).run().changes;
      rowsDeleted += db.delete(stateReads).where(inArray(stateReads.branchId, branchIds)).run().changes;
      rowsDeleted += db.delete(steps).where(inArray(steps.branchId, branchIds)).run().changes;
      rowsDeleted += db.delete(snapshots).where(inArray(snapshots.branchId, branchIds)).run().changes;
    }
    rowsDeleted += db.delete(runEvents).where(eq(runEvents.executionId, executionId)).run().changes;
    rowsDeleted += db.delete(executionTriggers).where(eq(executionTriggers.executionId, executionId)).run().changes;
    if (contextIds.length > 0) rowsDeleted += db.delete(contexts).where(eq(contexts.executionId, executionId)).run().changes;
    if (branchIds.length > 0) rowsDeleted += db.delete(branches).where(eq(branches.executionId, executionId)).run().changes;
    rowsDeleted += db.delete(executions).where(eq(executions.id, executionId)).run().changes;

    // Phase C — scoped blob sweep: subtract refs still alive in a surviving snapshot, then
    // delete whatever's left with no remaining FK pointing at it.
    subtractSurvivingSnapshotRefs(db, candidates);
    const { blobsDeleted, bytesReclaimed } = sweepDeadBlobs(db, candidates);

    return { executionId, rowsDeleted, blobsDeleted, bytesReclaimed };
  });
}

export interface ExecutionGcOptions {
  /** Only an execution whose `endedAt ?? startedAt` is older than this is even eligible.
   *  Defaults to `FLOWLATHE_EXECUTION_GC_OLDER_THAN_DAYS`, else 30. */
  olderThanDays?: number;
  /** A `running`/`awaiting_input` execution is only eligible once it is this old — nothing in
   *  this repo reconciles a crash-orphaned status, so such a row would otherwise be immortal.
   *  Defaults to `FLOWLATHE_EXECUTION_GC_ABANDONED_AFTER_DAYS`, else 7.
   *
   *  Must stay comfortably above the Discord recovery scan's `recoveryWindowSeconds`
   *  (`triggers/discord.ts:88`, default 900s) — that window is the only thing that can
   *  re-present a collected `execution_triggers.external_id`, and once an execution is old
   *  enough for this guard to matter, that window has already closed. */
  abandonedAfterDays?: number;
}

export interface ExecutionGcResult {
  flowId: string;
  executions: number;
  blobs: number;
  bytes: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Retention for one flow's executions (D2: age-only, no `keepNewest` — a 30-day cutoff already
 * puts every live execution out of reach, and `ExecutionHub` has no reliable live-execution list
 * to protect otherwise). Iterates newest-first via `listExecutionsForFlow`, applying one guard
 * per line, matching `flow-version-gc.ts`'s shape.
 */
export function gcExecutions(db: Db, flowId: string, opts: ExecutionGcOptions = {}): ExecutionGcResult {
  const olderThanDays = opts.olderThanDays ?? envInt("FLOWLATHE_EXECUTION_GC_OLDER_THAN_DAYS", 30);
  const abandonedAfterDays = opts.abandonedAfterDays ?? envInt("FLOWLATHE_EXECUTION_GC_ABANDONED_AFTER_DAYS", 7);
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const abandonedCutoff = new Date(Date.now() - abandonedAfterDays * 24 * 60 * 60 * 1000).toISOString();

  const rows = listExecutionsForFlow(db, flowId);

  let deletedCount = 0;
  let blobsDeleted = 0;
  let bytesReclaimed = 0;
  for (const row of rows) {
    const isLive = row.status === "running" || row.status === "awaiting_input";
    if (isLive && row.startedAt > abandonedCutoff) continue; // not abandoned yet — a live debug session
    const effectiveEnd = row.endedAt ?? row.startedAt;
    if (effectiveEnd > cutoff) continue; // not old enough yet
    const result = deleteExecution(db, row.id);
    deletedCount++;
    blobsDeleted += result.blobsDeleted;
    bytesReclaimed += result.bytesReclaimed;
  }

  if (deletedCount > 0) {
    console.log(`[execution-gc] collected ${deletedCount} execution(s), ${blobsDeleted} blob(s), ${(bytesReclaimed / 1024 / 1024).toFixed(2)} MB from flow ${flowId}`);
  }
  return { flowId, executions: deletedCount, blobs: blobsDeleted, bytes: bytesReclaimed };
}

/** Retention for one flow's whole history, in the only order that makes progress: executions
 *  first (a live execution is a `gcFlowVersions` keep-reason — flow-version-gc.ts:52), then the
 *  versions those executions were pinning. The other order collects nothing on the first pass.
 *  This — not `gcExecutions` alone — is what callers should reach for. */
export function gcFlowHistory(
  db: Db,
  flowId: string,
  opts?: { executions?: ExecutionGcOptions; versions?: FlowVersionGcOptions },
): { executions: ExecutionGcResult; versions: ReturnType<typeof gcFlowVersions> } {
  const executionsResult = gcExecutions(db, flowId, opts?.executions);
  const versionsResult = gcFlowVersions(db, flowId, opts?.versions);
  return { executions: executionsResult, versions: versionsResult };
}

export function gcAllExecutions(db: Db, opts?: ExecutionGcOptions): ExecutionGcResult[] {
  const flowIds = db.select({ id: flows.id }).from(flows).all().map((r) => r.id);
  return flowIds.map((flowId) => gcExecutions(db, flowId, opts));
}
