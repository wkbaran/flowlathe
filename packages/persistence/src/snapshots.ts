import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db.js";
import { snapshots } from "./schema.js";

export interface SnapshotRecord {
  id: string;
  branchId: string;
  stepIndex: number;
  parentSnapshotId: string | null;
  payload: unknown;
  sizeBytes: number;
  createdAt: string;
}

export interface CreateSnapshotInput {
  branchId: string;
  stepIndex: number;
  parentSnapshotId?: string | undefined;
  payload: unknown;
}

const columns = {
  id: snapshots.id,
  branchId: snapshots.branchId,
  stepIndex: snapshots.stepIndex,
  parentSnapshotId: snapshots.parentSnapshotId,
  payload: snapshots.payloadJson,
  sizeBytes: snapshots.sizeBytes,
  createdAt: snapshots.createdAt,
};

export function createSnapshot(db: Db, input: CreateSnapshotInput): SnapshotRecord {
  const id = randomUUID();
  const json = JSON.stringify(input.payload);
  db.insert(snapshots)
    .values({
      id,
      branchId: input.branchId,
      stepIndex: input.stepIndex,
      parentSnapshotId: input.parentSnapshotId ?? null,
      payloadJson: input.payload,
      sizeBytes: Buffer.byteLength(json, "utf-8"),
    })
    .run();
  return mustGetSnapshot(db, id);
}

export function getSnapshot(db: Db, id: string): SnapshotRecord | undefined {
  return db.select(columns).from(snapshots).where(eq(snapshots.id, id)).get();
}

export function listSnapshotsForBranch(db: Db, branchId: string): SnapshotRecord[] {
  return db.select(columns).from(snapshots).where(eq(snapshots.branchId, branchId)).all();
}

function mustGetSnapshot(db: Db, id: string): SnapshotRecord {
  const row = getSnapshot(db, id);
  if (!row) throw new Error(`snapshot not found: ${id}`);
  return row;
}
