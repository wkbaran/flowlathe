import { emptyFlowGraph } from "@flowlathe/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type OpenedDb, openDb } from "./db.js";
import { beginStep, startExecution } from "./executions.js";
import { createFlow } from "./flows.js";
import { runMigrations } from "./migrate.js";
import {
  getStateDecls,
  getStateSnapshot,
  listStateLineage,
  listStateWritesForBranch,
  recordStateRead,
  recordStateWrite,
  saveStateDecls,
} from "./state.js";

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
});

describe("state decls", () => {
  it("saves and reads back a flow version's declared state entries", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    saveStateDecls(opened.db, flow.flowVersionId, [
      { name: "findings", type: "array", merge: "append", initial: [] },
      { name: "count", type: "number", merge: "numeric-add" },
    ]);
    const decls = getStateDecls(opened.db, flow.flowVersionId);
    expect(decls.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: "count", type: "number", merge: "numeric-add", initial: undefined },
      { name: "findings", type: "array", merge: "append", initial: [] },
    ]);
  });
});

describe("state writes/reads", () => {
  it("records writes as content-addressed rows and lists them back in seq order", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const branchId = startExecution(opened.db, flow.flowVersionId).branchId;

    recordStateWrite(opened.db, { branchId, entry: "findings", value: ["a"], merge: "append", seq: 1 });
    recordStateWrite(opened.db, { branchId, entry: "findings", value: ["a", "b"], merge: "append", seq: 2 });
    recordStateRead(opened.db, { branchId, entry: "findings", seqSeen: 2 });

    const writes = listStateWritesForBranch(opened.db, branchId);
    expect(writes).toEqual([
      { entry: "findings", value: ["a"], seq: 1 },
      { entry: "findings", value: ["a", "b"], seq: 2 },
    ]);
  });

  it("getStateSnapshot returns the current (last-write) value per entry", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const branchId = startExecution(opened.db, flow.flowVersionId).branchId;

    recordStateWrite(opened.db, { branchId, entry: "count", value: 1, merge: "numeric-add", seq: 1 });
    recordStateWrite(opened.db, { branchId, entry: "count", value: 3, merge: "numeric-add", seq: 2 });
    recordStateWrite(opened.db, { branchId, entry: "topic", value: "cats", merge: "replace", seq: 3 });

    expect(getStateSnapshot(opened.db, branchId)).toEqual({ count: 3, topic: "cats" });
  });

  it("listStateLineage connects the node that wrote an entry to the node that read it", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const branchId = startExecution(opened.db, flow.flowVersionId).branchId;

    const writerStepId = beginStep(opened.db, { branchId, nodeId: "writer-node" });
    recordStateWrite(opened.db, { branchId, stepId: writerStepId, entry: "notes", value: "hi", merge: "replace", seq: 1 });

    const readerStepId = beginStep(opened.db, { branchId, nodeId: "reader-node" });
    recordStateRead(opened.db, { branchId, stepId: readerStepId, entry: "notes", seqSeen: 1 });

    expect(listStateLineage(opened.db, branchId)).toEqual([
      { entry: "notes", writerNodeId: "writer-node", writerSeq: 1, readerNodeId: "reader-node" },
    ]);
  });
});
