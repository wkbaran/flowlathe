import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db.js";
import { branches } from "./schema.js";

export interface BranchRecord {
  id: string;
  executionId: string;
  parentBranchId: string | null;
  forkedFromSnapshotId: string | null;
  label: string | null;
  createdAt: string;
}

export interface CreateBranchInput {
  executionId: string;
  parentBranchId: string;
  forkedFromSnapshotId: string;
  label?: string | undefined;
}

/** Step-back-with-fork: the old branch is retained, never truncated. */
export function createBranch(db: Db, input: CreateBranchInput): BranchRecord {
  const id = randomUUID();
  db.insert(branches)
    .values({
      id,
      executionId: input.executionId,
      parentBranchId: input.parentBranchId,
      forkedFromSnapshotId: input.forkedFromSnapshotId,
      label: input.label ?? null,
    })
    .run();
  return mustGetBranch(db, id);
}

export function listBranches(db: Db, executionId: string): BranchRecord[] {
  return db.select().from(branches).where(eq(branches.executionId, executionId)).all();
}

export function getBranch(db: Db, id: string): BranchRecord | undefined {
  return db.select().from(branches).where(eq(branches.id, id)).get();
}

function mustGetBranch(db: Db, id: string): BranchRecord {
  const row = getBranch(db, id);
  if (!row) throw new Error(`branch not found: ${id}`);
  return row;
}
