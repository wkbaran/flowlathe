import { emptyFlowGraph } from "@flowlathe/core";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createBranch } from "./branches.js";
import { getBlob, putBlob, sha256Of } from "./blobs.js";
import { type OpenedDb, openDb } from "./db.js";
import { recordContextCompaction } from "./contexts.js";
import {
  collectSnapshotBlobRefs,
  deleteExecution,
  gcExecutions,
  gcFlowHistory,
} from "./execution-gc.js";
import { beginStep, recordResponse, startExecution } from "./executions.js";
import { gcFlowVersions } from "./flow-version-gc.js";
import { createFlow, saveFlowVersion } from "./flows.js";
import { runMigrations } from "./migrate.js";
import { executions, flowVersions, snapshots } from "./schema.js";
import { createSnapshot } from "./snapshots.js";
import { recordStateWrite } from "./state.js";
import { claimExecutionTrigger, createTrigger } from "./triggers.js";
import { SqliteBlobStore } from "./sqlite-blob-store.js";

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
});

function ageOutExecution(db: OpenedDb["db"], executionId: string, daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.update(executions).set({ startedAt: at, endedAt: at }).where(eq(executions.id, executionId)).run();
}

/** `PRAGMA foreign_key_check` returns one row per dangling FK across the WHOLE database — every
 *  FK-visible orphan in all tables, without enumerating them. The second half covers what
 *  `foreign_key_check` structurally cannot see: a snapshot payload ref with no blob row. */
function expectIntegrity(o: OpenedDb) {
  expect(o.sqlite.pragma("foreign_key_check")).toEqual([]);
  const refs = new Set<string>();
  for (const r of o.db.select({ p: snapshots.payloadJson }).from(snapshots).all()) collectSnapshotBlobRefs(r.p, refs);
  for (const sha of refs) expect(getBlob(o.db, sha), `snapshot ref ${sha} has no blob`).toBeDefined();
}

describe("deleteExecution — subtree deletion", () => {
  it("empties every scoped table for that execution, driven off a table list", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId, branchId } = startExecution(opened.db, flow.flowVersionId, "step");
    const step = beginStep(opened.db, { branchId, nodeId: "a" });
    const responseId = recordResponse(opened.db, {
      executionId,
      branchId,
      stepId: step,
      nodeId: "a",
      renderedPrompt: "prompt",
      content: "content",
      finishReason: "stop",
      latencyMs: 10,
    });
    opened.sqlite.prepare("INSERT INTO tool_calls (id, response_id, tool_name, args_json) VALUES (?,?,?,?)").run(
      "tc1",
      responseId,
      "read_state",
      "{}",
    );
    recordStateWrite(opened.db, { branchId, stepId: step, entry: "count", value: 1, merge: "replace", seq: 1 });
    createSnapshot(opened.db, { branchId, stepIndex: 0, payload: {} });
    const trigger = createTrigger(opened.db, { flowId: flow.id, flowVersionId: flow.flowVersionId, source: "discord", config: {} });
    claimExecutionTrigger(opened.db, { executionId, triggerId: trigger.id, source: "discord", externalId: "ext-1", payload: Buffer.from("hi") });
    recordContextCompaction(opened.db, {
      executionId,
      nodeId: "a",
      method: "drop-oldest-half",
      sourceMessages: [{ role: "user", content: "hi" }],
      resultMessages: [{ role: "user", content: "hi" }],
    });

    deleteExecution(opened.db, executionId);

    for (const table of ["tool_calls", "state_writes", "steps", "snapshots", "execution_triggers", "branches"]) {
      const rows = opened.sqlite.prepare(`SELECT * FROM ${table}`).all();
      expect(rows, table).toEqual([]);
    }
    expect(opened.sqlite.prepare("SELECT * FROM responses").all()).toEqual([]);
    expect(opened.sqlite.prepare("SELECT * FROM contexts").all()).toEqual([]);
    expect(opened.sqlite.prepare("SELECT * FROM context_messages").all()).toEqual([]);
    expect(opened.sqlite.prepare("SELECT * FROM context_transform_calls").all()).toEqual([]);
    expect(opened.sqlite.prepare("SELECT * FROM messages").all()).toEqual([]);
    expect(opened.db.select().from(executions).where(eq(executions.id, executionId)).get()).toBeUndefined();
    expectIntegrity(opened);
  });

  it("leaves a second, untouched execution's rows alone", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const a = startExecution(opened.db, flow.flowVersionId, "step");
    const b = startExecution(opened.db, flow.flowVersionId, "step");
    const stepB = beginStep(opened.db, { branchId: b.branchId, nodeId: "x" });
    recordStateWrite(opened.db, { branchId: b.branchId, stepId: stepB, entry: "e", value: 1, merge: "replace", seq: 1 });

    deleteExecution(opened.db, a.executionId);

    expect(opened.db.select().from(executions).where(eq(executions.id, b.executionId)).get()).toBeDefined();
    expect(opened.sqlite.prepare("SELECT * FROM state_writes").all()).toHaveLength(1);
    expectIntegrity(opened);
  });

  it("is a no-op, not a throw, when called a second time on the same id", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId } = startExecution(opened.db, flow.flowVersionId, "step");
    deleteExecution(opened.db, executionId);
    expect(() => deleteExecution(opened.db, executionId)).not.toThrow();
    expectIntegrity(opened);
  });
});

describe("deleteExecution — blob liveness", () => {
  it("a blob shared by two executions' responses survives deleting one of them", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const a = startExecution(opened.db, flow.flowVersionId, "step");
    const b = startExecution(opened.db, flow.flowVersionId, "step");
    const stepA = beginStep(opened.db, { branchId: a.branchId, nodeId: "n" });
    const stepB = beginStep(opened.db, { branchId: b.branchId, nodeId: "n" });
    recordResponse(opened.db, {
      executionId: a.executionId,
      branchId: a.branchId,
      stepId: stepA,
      nodeId: "n",
      renderedPrompt: "same prompt",
      content: "same content",
      finishReason: "stop",
      latencyMs: 1,
    });
    recordResponse(opened.db, {
      executionId: b.executionId,
      branchId: b.branchId,
      stepId: stepB,
      nodeId: "n",
      renderedPrompt: "same prompt",
      content: "same content",
      finishReason: "stop",
      latencyMs: 1,
    });
    const contentSha = sha256Of(Buffer.from("same content", "utf-8"));
    expect(opened.sqlite.prepare("SELECT count(*) as n FROM blobs WHERE sha256 = ?").get(contentSha)).toEqual({ n: 1 });

    deleteExecution(opened.db, a.executionId);

    expect(getBlob(opened.db, contentSha)).toBeDefined();
    const bResponse = opened.sqlite.prepare("SELECT content_sha FROM responses WHERE execution_id = ?").get(b.executionId) as { content_sha: string };
    expect(bResponse.content_sha).toBe(contentSha);
    expectIntegrity(opened);
  });

  it("honours a snapshot-payload-only reference in a DIFFERENT, surviving execution", () => {
    // This is the version that matters: a naive FK-only sweep would already leave this blob
    // alone (it's never a candidate), so it only proves anything if Phase C.1 actually parses
    // the surviving execution's payload.
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const a = startExecution(opened.db, flow.flowVersionId, "step");
    const b = startExecution(opened.db, flow.flowVersionId, "step");
    const stepA = beginStep(opened.db, { branchId: a.branchId, nodeId: "n" });
    recordResponse(opened.db, {
      executionId: a.executionId,
      branchId: a.branchId,
      stepId: stepA,
      nodeId: "n",
      renderedPrompt: "p",
      content: "shared-value",
      finishReason: "stop",
      latencyMs: 1,
    });
    const sha = sha256Of(Buffer.from("shared-value", "utf-8"));
    // execution B references the SAME sha only via a snapshot payload, never a FK column.
    createSnapshot(opened.db, { branchId: b.branchId, stepIndex: 0, payload: { outputs: { n: { output: { kind: "value", ref: sha } } } } });

    deleteExecution(opened.db, a.executionId);

    expect(getBlob(opened.db, sha)).toBeDefined();
    expectIntegrity(opened);
  });

  it("collects a blob referenced only by the deleted execution's own snapshot payload", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId, branchId } = startExecution(opened.db, flow.flowVersionId, "step");
    const sha = putBlob(opened.db, Buffer.from("only-in-snapshot", "utf-8"));
    createSnapshot(opened.db, { branchId, stepIndex: 0, payload: { outputs: { n: { output: { kind: "value", ref: sha } } } } });

    deleteExecution(opened.db, executionId);

    expect(getBlob(opened.db, sha)).toBeUndefined();
    expectIntegrity(opened);
  });

  it("preserves both branches' snapshot refs when a DIFFERENT execution is deleted (cross-branch)", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const kept = startExecution(opened.db, flow.flowVersionId, "step");
    const sha = putBlob(opened.db, Buffer.from("kept-value", "utf-8"));
    const snap0 = createSnapshot(opened.db, {
      branchId: kept.branchId,
      stepIndex: 0,
      payload: { outputs: { n: { output: { kind: "value", ref: sha } } } },
    });
    // Mirrors stepBack's fork: a new branch under the SAME execution, whose snapshot copies the
    // parent's payload verbatim (stepper.ts:168-173) — built with persistence primitives only,
    // since stepBack itself lives in @flowlathe/server.
    const forkedBranch = createBranch(opened.db, {
      executionId: kept.executionId,
      parentBranchId: kept.branchId,
      forkedFromSnapshotId: snap0.id,
    });
    createSnapshot(opened.db, { branchId: forkedBranch.id, stepIndex: 0, parentSnapshotId: snap0.id, payload: snap0.payload });

    const other = startExecution(opened.db, flow.flowVersionId, "step");
    deleteExecution(opened.db, other.executionId);

    expect(getBlob(opened.db, sha)).toBeDefined();
    expectIntegrity(opened);
  });

  it("an unrooted SqliteBlobStore blob survives deleting an execution, unless content-identical to a deleted value", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId, branchId } = startExecution(opened.db, flow.flowVersionId, "step");
    const step = beginStep(opened.db, { branchId, nodeId: "n" });
    recordResponse(opened.db, {
      executionId,
      branchId,
      stepId: step,
      nodeId: "n",
      renderedPrompt: "p",
      content: "duplicate-me",
      finishReason: "stop",
      latencyMs: 1,
    });

    const store = new SqliteBlobStore(opened.db);
    const uniqueSha = store.put(Buffer.from("truly-unique-unrooted", "utf-8"));
    // Documented hazard (sqlite-blob-store.ts): content-addressed, so this is the SAME row as
    // the response's content blob, and gets collected alongside it — pinned here, not fixed.
    const duplicateSha = store.put(Buffer.from("duplicate-me", "utf-8"));

    deleteExecution(opened.db, executionId);

    expect(getBlob(opened.db, uniqueSha)).toBeDefined();
    expect(getBlob(opened.db, duplicateSha)).toBeUndefined();
    expectIntegrity(opened);
  });
});

describe("deleteExecution — contexts and messages", () => {
  it("removes contexts, context_messages, context_transform_calls, messages, and their blobs", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId } = startExecution(opened.db, flow.flowVersionId, "step");
    recordContextCompaction(opened.db, {
      executionId,
      nodeId: "n",
      method: "drop-oldest-half",
      sourceMessages: [{ role: "user", content: "only-here" }],
      resultMessages: [{ role: "user", content: "only-here" }],
    });
    const sha = sha256Of(Buffer.from("only-here", "utf-8"));

    deleteExecution(opened.db, executionId);

    expect(opened.sqlite.prepare("SELECT * FROM contexts").all()).toEqual([]);
    expect(opened.sqlite.prepare("SELECT * FROM context_messages").all()).toEqual([]);
    expect(opened.sqlite.prepare("SELECT * FROM context_transform_calls").all()).toEqual([]);
    expect(opened.sqlite.prepare("SELECT * FROM messages").all()).toEqual([]);
    expect(getBlob(opened.db, sha)).toBeUndefined();
    expectIntegrity(opened);
  });

  it("keeps a second execution's compacted messages (and their shared content blob) alive", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const a = startExecution(opened.db, flow.flowVersionId, "step");
    const b = startExecution(opened.db, flow.flowVersionId, "step");
    recordContextCompaction(opened.db, {
      executionId: a.executionId,
      nodeId: "n",
      method: "drop-oldest-half",
      sourceMessages: [{ role: "user", content: "shared-text" }],
      resultMessages: [{ role: "user", content: "shared-text" }],
    });
    recordContextCompaction(opened.db, {
      executionId: b.executionId,
      nodeId: "n",
      method: "drop-oldest-half",
      sourceMessages: [{ role: "user", content: "shared-text" }],
      resultMessages: [{ role: "user", content: "shared-text" }],
    });
    const sha = sha256Of(Buffer.from("shared-text", "utf-8"));

    deleteExecution(opened.db, a.executionId);

    expect(getBlob(opened.db, sha)).toBeDefined();
    expect(opened.sqlite.prepare("SELECT count(*) as n FROM context_messages").get()).toEqual({ n: expect.any(Number) });
    const remaining = opened.sqlite.prepare("SELECT count(*) as n FROM messages").get() as { n: number };
    expect(remaining.n).toBeGreaterThan(0);
    expectIntegrity(opened);
  });
});

describe("gcExecutions — policy guards", () => {
  it("never deletes a running execution", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId } = startExecution(opened.db, flow.flowVersionId, "run");
    ageOutExecution(opened.db, executionId, 30);
    gcExecutions(opened.db, flow.id, { olderThanDays: 0, abandonedAfterDays: 999 });
    expect(opened.db.select().from(executions).where(eq(executions.id, executionId)).get()).toBeDefined();
  });

  it("never deletes an awaiting_input execution", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId } = startExecution(opened.db, flow.flowVersionId, "run");
    opened.db.update(executions).set({ status: "awaiting_input" }).where(eq(executions.id, executionId)).run();
    ageOutExecution(opened.db, executionId, 30);
    gcExecutions(opened.db, flow.id, { olderThanDays: 0, abandonedAfterDays: 999 });
    expect(opened.db.select().from(executions).where(eq(executions.id, executionId)).get()).toBeDefined();
  });

  it("deletes a running execution once it is older than abandonedAfterDays", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId } = startExecution(opened.db, flow.flowVersionId, "run");
    ageOutExecution(opened.db, executionId, 30);
    gcExecutions(opened.db, flow.id, { olderThanDays: 0, abandonedAfterDays: 7 });
    expect(opened.db.select().from(executions).where(eq(executions.id, executionId)).get()).toBeUndefined();
  });

  it("honours olderThanDays for a finished execution", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId } = startExecution(opened.db, flow.flowVersionId, "run");
    opened.db.update(executions).set({ status: "finished" }).where(eq(executions.id, executionId)).run();
    // Fresh — not aged out.
    gcExecutions(opened.db, flow.id, { olderThanDays: 30, abandonedAfterDays: 7 });
    expect(opened.db.select().from(executions).where(eq(executions.id, executionId)).get()).toBeDefined();

    ageOutExecution(opened.db, executionId, 31);
    gcExecutions(opened.db, flow.id, { olderThanDays: 30, abandonedAfterDays: 7 });
    expect(opened.db.select().from(executions).where(eq(executions.id, executionId)).get()).toBeUndefined();
  });

  it("falls back to startedAt when endedAt is null", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId } = startExecution(opened.db, flow.flowVersionId, "run");
    opened.db.update(executions).set({ status: "finished", endedAt: null }).where(eq(executions.id, executionId)).run();
    const at = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    opened.db.update(executions).set({ startedAt: at }).where(eq(executions.id, executionId)).run();

    gcExecutions(opened.db, flow.id, { olderThanDays: 30, abandonedAfterDays: 7 });
    expect(opened.db.select().from(executions).where(eq(executions.id, executionId)).get()).toBeUndefined();
  });
});

describe("gcFlowHistory — ordering with gcFlowVersions", () => {
  it("executions-first unblocks a flow version that gcFlowVersions alone cannot collect", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const v2 = saveFlowVersion(opened.db, flow.id, { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] }, "v2");
    saveFlowVersion(opened.db, flow.id, { nodes: [{ id: "b", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] }, "v3");
    const { executionId } = startExecution(opened.db, v2.flowVersionId, "run");
    opened.db.update(executions).set({ status: "finished" }).where(eq(executions.id, executionId)).run();
    ageOutExecution(opened.db, executionId, 999);

    // (a) gcFlowVersions alone deletes nothing — the execution still references v2.
    gcFlowVersions(opened.db, flow.id, { keepNewest: 0, olderThanDays: 0 });
    expect(opened.db.select().from(flowVersions).where(eq(flowVersions.id, v2.flowVersionId)).get()).toBeDefined();
  });

  it("(b) gcExecutions alone deletes the execution but leaves v2; (c) gcFlowHistory deletes both", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const v2 = saveFlowVersion(opened.db, flow.id, { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] }, "v2");
    saveFlowVersion(opened.db, flow.id, { nodes: [{ id: "b", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] }, "v3");
    const { executionId } = startExecution(opened.db, v2.flowVersionId, "run");
    opened.db.update(executions).set({ status: "finished" }).where(eq(executions.id, executionId)).run();
    ageOutExecution(opened.db, executionId, 999);

    gcExecutions(opened.db, flow.id, { olderThanDays: 0, abandonedAfterDays: 0 });
    expect(opened.db.select().from(executions).where(eq(executions.id, executionId)).get()).toBeUndefined();
    // v2 wasn't touched by gcExecutions itself — it's still there until gcFlowVersions runs.
    expect(opened.db.select().from(flowVersions).where(eq(flowVersions.id, v2.flowVersionId)).get()).toBeDefined();

    gcFlowVersions(opened.db, flow.id, { keepNewest: 0, olderThanDays: 0 });
    expect(opened.db.select().from(flowVersions).where(eq(flowVersions.id, v2.flowVersionId)).get()).toBeUndefined();
  });

  it("gcFlowHistory collects both the execution and the version it was pinning, in one pass", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const v2 = saveFlowVersion(opened.db, flow.id, { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] }, "v2");
    saveFlowVersion(opened.db, flow.id, { nodes: [{ id: "b", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] }, "v3");
    const { executionId } = startExecution(opened.db, v2.flowVersionId, "run");
    opened.db.update(executions).set({ status: "finished" }).where(eq(executions.id, executionId)).run();
    ageOutExecution(opened.db, executionId, 999);

    gcFlowHistory(opened.db, flow.id, { executions: { olderThanDays: 0, abandonedAfterDays: 0 }, versions: { keepNewest: 0, olderThanDays: 0 } });

    expect(opened.db.select().from(executions).where(eq(executions.id, executionId)).get()).toBeUndefined();
    expect(opened.db.select().from(flowVersions).where(eq(flowVersions.id, v2.flowVersionId)).get()).toBeUndefined();
  });
});
