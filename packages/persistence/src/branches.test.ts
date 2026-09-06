import { emptyFlowGraph } from "@flowlathe/core";
import { beforeEach, describe, expect, it } from "vitest";
import { createBranch, getBranch, listBranches } from "./branches.js";
import { type OpenedDb, openDb } from "./db.js";
import { createFlow } from "./flows.js";
import { runMigrations } from "./migrate.js";
import { createSnapshot } from "./snapshots.js";
import { startExecution } from "./executions.js";

let opened: OpenedDb;
let flowVersionId: string;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
  flowVersionId = flow.flowVersionId;
});

describe("branch repository", () => {
  it("forks a new branch from a snapshot, retaining the original", () => {
    const { executionId, branchId: rootBranchId } = startExecution(opened.db, flowVersionId);
    const snapshot = createSnapshot(opened.db, { branchId: rootBranchId, stepIndex: 0, payload: { outputs: {} } });

    const forked = createBranch(opened.db, {
      executionId,
      parentBranchId: rootBranchId,
      forkedFromSnapshotId: snapshot.id,
      label: "step-back",
    });

    expect(forked.parentBranchId).toBe(rootBranchId);
    expect(forked.forkedFromSnapshotId).toBe(snapshot.id);

    const all = listBranches(opened.db, executionId);
    expect(all.map((b) => b.id).sort()).toEqual([rootBranchId, forked.id].sort());
    expect(getBranch(opened.db, rootBranchId)).toBeDefined();
  });
});
