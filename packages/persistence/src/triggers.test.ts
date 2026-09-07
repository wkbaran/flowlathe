import { emptyFlowGraph } from "@flowlathe/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimExecutionTrigger,
  createTrigger,
  deleteTrigger,
  executionTriggerExistsForExternalId,
  getTrigger,
  getTriggerCursor,
  listTriggers,
  setTriggerCursor,
  setTriggerEnabled,
} from "./triggers.js";
import { type OpenedDb, openDb } from "./db.js";
import { createFlow } from "./flows.js";
import { startExecution } from "./executions.js";
import { runMigrations } from "./migrate.js";

let opened: OpenedDb;
let flowId: string;
let flowVersionId: string;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
  flowId = flow.id;
  flowVersionId = flow.flowVersionId;
});

describe("trigger repository", () => {
  it("creates a trigger pinned to a specific flow version", () => {
    const trigger = createTrigger(opened.db, {
      flowId,
      flowVersionId,
      source: "discord",
      config: { channelIds: ["c1"] },
    });
    expect(trigger.flowVersionId).toBe(flowVersionId);
    expect(trigger.enabled).toBe(true);
    expect(trigger.configJson).toEqual({ channelIds: ["c1"] });
    expect(getTrigger(opened.db, trigger.id)?.id).toBe(trigger.id);
    expect(listTriggers(opened.db).map((t) => t.id)).toEqual([trigger.id]);
  });

  it("can be disabled and deleted", () => {
    const trigger = createTrigger(opened.db, { flowId, flowVersionId, source: "discord", config: {} });
    setTriggerEnabled(opened.db, trigger.id, false);
    expect(getTrigger(opened.db, trigger.id)?.enabled).toBe(false);
    deleteTrigger(opened.db, trigger.id);
    expect(getTrigger(opened.db, trigger.id)).toBeUndefined();
  });
});

describe("execution trigger dedupe", () => {
  it("claims an external id exactly once, surviving across calls", () => {
    const trigger = createTrigger(opened.db, { flowId, flowVersionId, source: "discord", config: {} });
    const { executionId: exec1 } = startExecution(opened.db, flowVersionId);
    const { executionId: exec2 } = startExecution(opened.db, flowVersionId);

    const firstClaim = claimExecutionTrigger(opened.db, {
      executionId: exec1,
      triggerId: trigger.id,
      source: "discord",
      externalId: "msg-1",
      payload: Buffer.from("{}"),
    });
    expect(firstClaim).toBe(true);

    const secondClaim = claimExecutionTrigger(opened.db, {
      executionId: exec2,
      triggerId: trigger.id,
      source: "discord",
      externalId: "msg-1",
      payload: Buffer.from("{}"),
    });
    expect(secondClaim).toBe(false);
  });

  it("the non-claiming existence check doesn't itself claim", () => {
    expect(executionTriggerExistsForExternalId(opened.db, "never-seen")).toBe(false);
    const trigger = createTrigger(opened.db, { flowId, flowVersionId, source: "discord", config: {} });
    const { executionId } = startExecution(opened.db, flowVersionId);
    claimExecutionTrigger(opened.db, {
      executionId,
      triggerId: trigger.id,
      source: "discord",
      externalId: "msg-2",
      payload: Buffer.from("{}"),
    });
    expect(executionTriggerExistsForExternalId(opened.db, "msg-2")).toBe(true);
  });
});

describe("trigger cursors", () => {
  it("is undefined for a never-connected (trigger, channel) pair", () => {
    const trigger = createTrigger(opened.db, { flowId, flowVersionId, source: "discord", config: {} });
    expect(getTriggerCursor(opened.db, trigger.id, "c1")).toBeUndefined();
  });

  it("stores and updates a cursor", () => {
    const trigger = createTrigger(opened.db, { flowId, flowVersionId, source: "discord", config: {} });
    setTriggerCursor(opened.db, trigger.id, "c1", "msg-100");
    expect(getTriggerCursor(opened.db, trigger.id, "c1")).toBe("msg-100");
    setTriggerCursor(opened.db, trigger.id, "c1", "msg-200");
    expect(getTriggerCursor(opened.db, trigger.id, "c1")).toBe("msg-200");
  });
});
