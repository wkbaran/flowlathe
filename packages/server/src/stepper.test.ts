import { emptyFlowGraph, type FlowGraph } from "@flowlathe/core";
import {
  beginStep,
  createFlow,
  createSnapshot,
  listStateWritesForBranch,
  type OpenedDb,
  openDb,
  putBlob,
  recordStateWrite,
  runMigrations,
  startExecution,
} from "@flowlathe/persistence";
import { MockProviderAdapter, SimpleScheduler } from "@flowlathe/providers";
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionHub } from "./execution-hub.js";
import { startStepExecution, stepOnce, stepBack } from "./stepper.js";

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

describe("startStepExecution — seed", () => {
  function triggerGraph(): FlowGraph {
    return {
      nodes: [
        { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { source: "discord", testPayload: "SHOULD_NOT_APPEAR" } },
        { id: "b", type: "prompt", position: { x: 1, y: 0 }, data: { template: "got: {{input}}", providerId: "mock", modelId: "m" } },
      ],
      edges: [{ id: "t-b", source: "t", target: "b", sourceHandle: "content", targetHandle: "input" }],
      state: [],
    };
  }

  it("bakes the seed into the first snapshot, so stepping never dispatches the trigger", async () => {
    const flow = createFlow(opened.db, "Triggered Flow", triggerGraph());
    const { executionId, branchId } = startStepExecution(opened.db, flow.flowVersionId, {
      t: { content: "REAL_MESSAGE", authorId: "u1", channelId: "c1", messageId: "m1" },
    });

    const hub = new ExecutionHub();
    const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 4 } });

    const first = await stepOnce({ db: opened.db, hub, scheduler, graph: flow.graph, executionId, branchId });
    expect(first.done).toBe(false);
    // The trigger node ("t") is already resolved by the seed — the very first step dispatches
    // the downstream prompt directly, never the trigger itself.
    expect(first.nodeId).toBe("b");

    const second = await stepOnce({ db: opened.db, hub, scheduler, graph: flow.graph, executionId, branchId });
    expect(second.done).toBe(true);
  });

  it("with no seed, a manual/canvas step-start still lets the trigger dispatch normally", async () => {
    const flow = createFlow(opened.db, "Untriggered Flow", triggerGraph());
    const { executionId, branchId } = startStepExecution(opened.db, flow.flowVersionId);

    const hub = new ExecutionHub();
    const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 4 } });

    const first = await stepOnce({ db: opened.db, hub, scheduler, graph: flow.graph, executionId, branchId });
    expect(first.nodeId).toBe("t");
  });
});

describe("stepOnce — blob-loss safety (PLAN-EXECUTION-RETENTION.md S1)", () => {
  it("rejects, naming the sha, rather than silently restoring an empty string when a snapshot's blob is missing", async () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId, branchId } = startExecution(opened.db, flow.flowVersionId, "step");

    const sha = putBlob(opened.db, Buffer.from("gone", "utf-8"));
    // Mirrors stepper.ts:28's SerializedSnapshotPayload shape: {outputs: {nodeId: {port: {kind, ref}}}}
    createSnapshot(opened.db, { branchId, stepIndex: 0, payload: { outputs: { a: { output: { kind: "value", ref: sha } } } } });
    // snapshot payload refs are not FK columns (CLAUDE.md) — deleting the blob directly is legal.
    opened.sqlite.prepare("DELETE FROM blobs WHERE sha256 = ?").run(sha);

    const hub = new ExecutionHub();
    const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 4 } });

    await expect(
      stepOnce({ db: opened.db, hub, scheduler, graph: emptyFlowGraph(), executionId, branchId }),
    ).rejects.toThrow(new RegExp(sha));
  });
});
