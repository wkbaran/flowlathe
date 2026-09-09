import { randomUUID } from "node:crypto";
import type { StateDecl } from "@flowlathe/core";
import { asc, eq } from "drizzle-orm";
import { getBlob, putBlob } from "./blobs.js";
import type { Db } from "./db.js";
import { stateDecls, stateReads, stateWrites, steps } from "./schema.js";

export function saveStateDecls(db: Db, flowVersionId: string, decls: StateDecl[]): void {
  for (const decl of decls) {
    db.insert(stateDecls)
      .values({
        flowVersionId,
        name: decl.name,
        typeJson: decl.type,
        merge: decl.merge,
        initialJson: decl.initial ?? null,
        fileMode: decl.fileMode ?? null,
        versioned: decl.versioned ?? null,
        filePath: decl.filePath ?? null,
      })
      .onConflictDoUpdate({
        target: [stateDecls.flowVersionId, stateDecls.name],
        set: {
          merge: decl.merge,
          typeJson: decl.type,
          initialJson: decl.initial ?? null,
          fileMode: decl.fileMode ?? null,
          versioned: decl.versioned ?? null,
          filePath: decl.filePath ?? null,
        },
      })
      .run();
  }
}

export function getStateDecls(db: Db, flowVersionId: string): StateDecl[] {
  return db
    .select({
      name: stateDecls.name,
      merge: stateDecls.merge,
      type: stateDecls.typeJson,
      initial: stateDecls.initialJson,
      fileMode: stateDecls.fileMode,
      versioned: stateDecls.versioned,
      filePath: stateDecls.filePath,
    })
    .from(stateDecls)
    .where(eq(stateDecls.flowVersionId, flowVersionId))
    .all()
    .map((row) => ({
      name: row.name,
      merge: row.merge,
      type: (row.type as StateDecl["type"]) ?? "string",
      initial: row.initial ?? undefined,
      ...(row.fileMode ? { fileMode: row.fileMode } : {}),
      ...(row.versioned !== null && row.versioned !== undefined ? { versioned: row.versioned } : {}),
      ...(row.filePath ? { filePath: row.filePath } : {}),
    }));
}

export interface RecordStateWriteInput {
  branchId: string;
  stepId?: string | undefined;
  entry: string;
  value: unknown;
  merge: string;
  seq: number;
}

export function recordStateWrite(db: Db, input: RecordStateWriteInput): void {
  const valueSha = putBlob(db, Buffer.from(JSON.stringify(input.value), "utf-8"));
  db.insert(stateWrites)
    .values({
      id: randomUUID(),
      branchId: input.branchId,
      stepId: input.stepId ?? null,
      entry: input.entry,
      valueSha,
      mergeApplied: input.merge,
      seq: input.seq,
    })
    .run();
}

export interface RecordStateReadInput {
  branchId: string;
  stepId?: string | undefined;
  entry: string;
  seqSeen: number;
}

export function recordStateRead(db: Db, input: RecordStateReadInput): void {
  db.insert(stateReads)
    .values({
      id: randomUUID(),
      branchId: input.branchId,
      stepId: input.stepId ?? null,
      entry: input.entry,
      seqSeen: input.seqSeen,
    })
    .run();
}

export interface StateWriteRow {
  entry: string;
  value: unknown;
  seq: number;
}

/**
 * All writes recorded so far on `branchId`, in seq order — the replay log a step-mode
 * StateStore resumes from. Reads only `branchId`'s own rows; a step-back fork's rows are
 * seeded at fork time (via `getStateSnapshotAsOf`, called from `stepBack`) rather than being
 * read here transitively from parent branches, mirroring how port-value forking already
 * copies a snapshot's payload forward.
 */
export function listStateWritesForBranch(db: Db, branchId: string): StateWriteRow[] {
  const rows = db
    .select({ entry: stateWrites.entry, valueSha: stateWrites.valueSha, seq: stateWrites.seq })
    .from(stateWrites)
    .where(eq(stateWrites.branchId, branchId))
    .orderBy(asc(stateWrites.seq))
    .all();
  return rows.map((row) => {
    const bytes = getBlob(db, row.valueSha);
    if (!bytes) throw new Error(`state write value blob missing: ${row.valueSha}`);
    return { entry: row.entry, value: JSON.parse(bytes.toString("utf-8")), seq: row.seq };
  });
}

/** Current value per entry on `branchId` — the last write wins (its value is already merged). */
export function getStateSnapshot(db: Db, branchId: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const write of listStateWritesForBranch(db, branchId)) values[write.entry] = write.value;
  return values;
}

export interface StateSnapshotRow extends StateWriteRow {
  merge: string;
}

/**
 * The last write per entry on `branchId`, as of `maxStepIndex` — bounded to writes whose owning
 * step is at or before that point. Used by `stepBack` to seed a forked branch's own state rows
 * at fork time, mirroring how a fork already copies the snapshot `payload` forward (see
 * CLAUDE.md). Preserves each entry's original `seq`/`merge` (not just its value) so the seeded
 * rows can be re-recorded verbatim via `recordStateWrite` and `StateStore`'s replay can keep
 * numbering `seq` forward without collision. A write with no recorded step (no activation key)
 * can't be bounded by step order, so it's always included.
 */
export function getStateSnapshotAsOf(db: Db, branchId: string, maxStepIndex: number): StateSnapshotRow[] {
  const stepIndexById = new Map(
    db
      .select({ id: steps.id, stepIndex: steps.stepIndex })
      .from(steps)
      .where(eq(steps.branchId, branchId))
      .all()
      .map((s) => [s.id, s.stepIndex]),
  );
  const rows = db
    .select({
      entry: stateWrites.entry,
      valueSha: stateWrites.valueSha,
      seq: stateWrites.seq,
      stepId: stateWrites.stepId,
      merge: stateWrites.mergeApplied,
    })
    .from(stateWrites)
    .where(eq(stateWrites.branchId, branchId))
    .orderBy(asc(stateWrites.seq))
    .all();

  const latest = new Map<string, StateSnapshotRow>();
  for (const row of rows) {
    const stepIndex = row.stepId ? stepIndexById.get(row.stepId) : undefined;
    if (row.stepId && stepIndex !== undefined && stepIndex > maxStepIndex) continue;
    const bytes = getBlob(db, row.valueSha);
    if (!bytes) throw new Error(`state write value blob missing: ${row.valueSha}`);
    const value = JSON.parse(bytes.toString("utf-8"));
    latest.set(row.entry, { entry: row.entry, value, seq: row.seq, merge: row.merge });
  }
  return [...latest.values()];
}

export interface StateLineageEdge {
  entry: string;
  writerNodeId: string;
  writerSeq: number;
  readerNodeId: string;
}

/**
 * The otherwise-invisible dependency between a node that writes a state entry and a node that
 * later reads it — no graph edge connects them, so the canvas renders this as a dashed line
 * instead. Resolves each write/read's owning node via `step_id -> steps.node_id`.
 */
export function listStateLineage(db: Db, branchId: string): StateLineageEdge[] {
  const writeRows = db
    .select({ entry: stateWrites.entry, seq: stateWrites.seq, stepId: stateWrites.stepId })
    .from(stateWrites)
    .where(eq(stateWrites.branchId, branchId))
    .all();
  const readRows = db
    .select({ entry: stateReads.entry, seqSeen: stateReads.seqSeen, stepId: stateReads.stepId })
    .from(stateReads)
    .where(eq(stateReads.branchId, branchId))
    .all();
  const stepRows = db.select({ id: steps.id, nodeId: steps.nodeId }).from(steps).where(eq(steps.branchId, branchId)).all();
  const nodeIdByStep = new Map(stepRows.map((s) => [s.id, s.nodeId]));

  const edges: StateLineageEdge[] = [];
  for (const read of readRows) {
    const readerNodeId = read.stepId ? nodeIdByStep.get(read.stepId) : undefined;
    if (!readerNodeId) continue;
    const writer = writeRows.find((w) => w.entry === read.entry && w.seq === read.seqSeen);
    const writerNodeId = writer?.stepId ? nodeIdByStep.get(writer.stepId) : undefined;
    if (!writer || !writerNodeId) continue;
    edges.push({ entry: read.entry, writerNodeId, writerSeq: writer.seq, readerNodeId });
  }
  return edges;
}
