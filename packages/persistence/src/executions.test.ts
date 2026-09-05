import { emptyFlowGraph } from "@flowlathe/core";
import { beforeEach, describe, expect, it } from "vitest";
import { getBlob } from "./blobs.js";
import {
  appendRunEvent,
  beginStep,
  finishExecution,
  finishStep,
  listRunEventsSince,
  recordResponse,
  startExecution,
} from "./executions.js";
import { type OpenedDb, openDb } from "./db.js";
import { createFlow } from "./flows.js";
import { runMigrations } from "./migrate.js";

let opened: OpenedDb;
let flowVersionId: string;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
  // the flow_versions row created alongside the flow is version 1; look it up directly.
  const row = opened.sqlite
    .prepare("select id from flow_versions where flow_id = ?")
    .get(flow.id) as { id: string };
  flowVersionId = row.id;
});

describe("execution lifecycle", () => {
  it("starts an execution with a root branch and can finish it", () => {
    const { executionId, branchId } = startExecution(opened.db, flowVersionId);
    expect(executionId).toBeTruthy();
    expect(branchId).toBeTruthy();
    finishExecution(opened.db, executionId, "finished");
    const row = opened.sqlite.prepare("select status from executions where id = ?").get(executionId) as {
      status: string;
    };
    expect(row.status).toBe("finished");
  });

  it("assigns increasing step indices per branch", () => {
    const { branchId } = startExecution(opened.db, flowVersionId);
    const step1 = beginStep(opened.db, { branchId, nodeId: "a" });
    finishStep(opened.db, step1, "done");
    const step2 = beginStep(opened.db, { branchId, nodeId: "b" });
    const rows = opened.sqlite
      .prepare("select step_index, node_id, status from steps where branch_id = ? order by step_index")
      .all(branchId) as { step_index: number; node_id: string; status: string }[];
    expect(rows).toEqual([
      { step_index: 0, node_id: "a", status: "done" },
      { step_index: 1, node_id: "b", status: "running" },
    ]);
    expect(step2).toBeTruthy();
  });

  it("records a response for a completed step", () => {
    const { executionId, branchId } = startExecution(opened.db, flowVersionId);
    const stepId = beginStep(opened.db, { branchId, nodeId: "a" });
    recordResponse(opened.db, {
      executionId,
      branchId,
      stepId,
      nodeId: "a",
      renderedPrompt: "hi",
      content: "hello",
      finishReason: "stop",
      latencyMs: 5,
    });
    const row = opened.sqlite
      .prepare("select node_id, rendered_prompt_sha, content_sha from responses where step_id = ?")
      .get(stepId) as { node_id: string; rendered_prompt_sha: string; content_sha: string };
    expect(row.node_id).toBe("a");
    expect(getBlob(opened.db, row.rendered_prompt_sha)?.toString("utf-8")).toBe("hi");
    expect(getBlob(opened.db, row.content_sha)?.toString("utf-8")).toBe("hello");
  });
});

describe("run events", () => {
  it("assigns increasing seq numbers per execution and lists events after a given seq", () => {
    const { executionId, branchId } = startExecution(opened.db, flowVersionId);
    appendRunEvent(opened.db, { executionId, branchId, kind: "node_started", payload: { nodeId: "a" } });
    appendRunEvent(opened.db, { executionId, branchId, kind: "node_finished", payload: { nodeId: "a" } });

    const all = listRunEventsSince(opened.db, executionId, 0);
    expect(all.map((e) => e.seq)).toEqual([1, 2]);

    const sinceOne = listRunEventsSince(opened.db, executionId, 1);
    expect(sinceOne.map((e) => e.kind)).toEqual(["node_finished"]);
  });
});
