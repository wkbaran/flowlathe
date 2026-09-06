import { emptyFlowGraph } from "@flowlathe/core";
import {
  beginStep,
  createFlow,
  createSnapshot,
  listStateWritesForBranch,
  type OpenedDb,
  openDb,
  recordStateWrite,
  runMigrations,
  startExecution,
} from "@flowlathe/persistence";
import { beforeEach, describe, expect, it } from "vitest";
import { stepBack } from "./stepper.js";

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
});

describe("stepBack — state forking", () => {
  it("seeds the forked branch with pre-fork state, and doesn't leak post-fork parent writes", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const branchId = startExecution(opened.db, flow.flowVersionId).branchId;

    const step0 = beginStep(opened.db, { branchId, nodeId: "a" });
    recordStateWrite(opened.db, { branchId, stepId: step0, entry: "count", value: 1, merge: "replace", seq: 1 });
    const snapshot0 = createSnapshot(opened.db, { branchId, stepIndex: 0, payload: {} });

    const step1 = beginStep(opened.db, { branchId, nodeId: "b" });
    recordStateWrite(opened.db, { branchId, stepId: step1, entry: "count", value: 2, merge: "replace", seq: 2 });
    createSnapshot(opened.db, { branchId, stepIndex: 1, parentSnapshotId: snapshot0.id, payload: {} });

    // Fork back to right after step0 — before step1's write ever happened.
    const forked = stepBack(opened.db, snapshot0.id);

    expect(listStateWritesForBranch(opened.db, forked.branchId)).toEqual([{ entry: "count", value: 1, seq: 1 }]);

    // A write made on the ORIGINAL branch after the fork point must never leak into the fork.
    const step2 = beginStep(opened.db, { branchId, nodeId: "c" });
    recordStateWrite(opened.db, { branchId, stepId: step2, entry: "count", value: 99, merge: "replace", seq: 3 });
    expect(listStateWritesForBranch(opened.db, forked.branchId)).toEqual([{ entry: "count", value: 1, seq: 1 }]);
  });

  it("carries forward writes with no owning step (no activation key) unconditionally", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const branchId = startExecution(opened.db, flow.flowVersionId).branchId;

    recordStateWrite(opened.db, { branchId, entry: "note", value: "hi", merge: "replace", seq: 1 });
    const snapshot0 = createSnapshot(opened.db, { branchId, stepIndex: 0, payload: {} });

    const forked = stepBack(opened.db, snapshot0.id);
    expect(listStateWritesForBranch(opened.db, forked.branchId)).toEqual([{ entry: "note", value: "hi", seq: 1 }]);
  });
});
