import { emptyFlowGraph } from "@flowlathe/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type OpenedDb, openDb } from "./db.js";
import { startExecution } from "./executions.js";
import { createFlow } from "./flows.js";
import { runMigrations } from "./migrate.js";
import { createSnapshot, getSnapshot, listSnapshotsForBranch } from "./snapshots.js";

let opened: OpenedDb;
let branchId: string;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
  branchId = startExecution(opened.db, flow.flowVersionId).branchId;
});

describe("snapshot repository", () => {
  it("stores and round-trips an arbitrary JSON payload", () => {
    const payload = { outputs: { a: { output: { kind: "value", value: "hi" } } } };
    const created = createSnapshot(opened.db, { branchId, stepIndex: 0, payload });
    expect(created.sizeBytes).toBeGreaterThan(0);

    const fetched = getSnapshot(opened.db, created.id);
    expect(fetched?.payload).toEqual(payload);
  });

  it("links snapshots via parentSnapshotId and lists them per branch", () => {
    const first = createSnapshot(opened.db, { branchId, stepIndex: 0, payload: {} });
    const second = createSnapshot(opened.db, {
      branchId,
      stepIndex: 1,
      parentSnapshotId: first.id,
      payload: {},
    });
    const all = listSnapshotsForBranch(opened.db, branchId);
    expect(all.map((s) => s.id).sort()).toEqual([first.id, second.id].sort());
    expect(second.parentSnapshotId).toBe(first.id);
  });
});
