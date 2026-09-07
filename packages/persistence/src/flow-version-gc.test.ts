import { emptyFlowGraph, type FlowGraph } from "@flowlathe/core";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { type OpenedDb, openDb } from "./db.js";
import { startExecution } from "./executions.js";
import { setFlowPin } from "./flow-pins.js";
import { gcFlowVersions } from "./flow-version-gc.js";
import { createFlow, saveFlowVersion } from "./flows.js";
import { runMigrations } from "./migrate.js";
import { flowVersions } from "./schema.js";
import { createTrigger } from "./triggers.js";

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
});

function ageOutRow(db: OpenedDb["db"], flowVersionId: string, daysAgo: number) {
  const createdAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.update(flowVersions).set({ createdAt }).where(eq(flowVersions.id, flowVersionId)).run();
}

function graphWith(id: string): FlowGraph {
  return { nodes: [{ id, type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
}

describe("gcFlowVersions", () => {
  it("never collects HEAD", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    ageOutRow(opened.db, flow.flowVersionId, 999);
    const result = gcFlowVersions(opened.db, flow.id, { keepNewest: 0, olderThanDays: 0 });
    expect(result.deleted).toBe(0);
  });

  it("never collects a named version, however old", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const v2 = saveFlowVersion(opened.db, flow.id, graphWith("a"), "v2", { label: "baseline" });
    saveFlowVersion(opened.db, flow.id, graphWith("b"), "v3"); // new HEAD, so v2 is no longer HEAD
    ageOutRow(opened.db, v2.flowVersionId, 999);

    gcFlowVersions(opened.db, flow.id, { keepNewest: 0, olderThanDays: 0 });
    const row = opened.db.select().from(flowVersions).where(eq(flowVersions.id, v2.flowVersionId)).get();
    expect(row).toBeDefined();
  });

  it("never collects a version an execution references", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const v2 = saveFlowVersion(opened.db, flow.id, graphWith("a"), "v2");
    saveFlowVersion(opened.db, flow.id, graphWith("b"), "v3");
    startExecution(opened.db, v2.flowVersionId, "run");
    ageOutRow(opened.db, v2.flowVersionId, 999);

    gcFlowVersions(opened.db, flow.id, { keepNewest: 0, olderThanDays: 0 });
    expect(opened.db.select().from(flowVersions).where(eq(flowVersions.id, v2.flowVersionId)).get()).toBeDefined();
  });

  it("never collects a version a trigger or a pin references", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const v2 = saveFlowVersion(opened.db, flow.id, graphWith("a"), "v2");
    const v3 = saveFlowVersion(opened.db, flow.id, graphWith("b"), "v3");
    saveFlowVersion(opened.db, flow.id, graphWith("c"), "v4");
    createTrigger(opened.db, { flowId: flow.id, flowVersionId: v2.flowVersionId, source: "discord", config: { channelIds: ["c1"] } });
    setFlowPin(opened.db, flow.id, "default", v3.flowVersionId);
    ageOutRow(opened.db, v2.flowVersionId, 999);
    ageOutRow(opened.db, v3.flowVersionId, 999);

    gcFlowVersions(opened.db, flow.id, { keepNewest: 0, olderThanDays: 0 });
    expect(opened.db.select().from(flowVersions).where(eq(flowVersions.id, v2.flowVersionId)).get()).toBeDefined();
    expect(opened.db.select().from(flowVersions).where(eq(flowVersions.id, v3.flowVersionId)).get()).toBeDefined();
  });

  it("keeps the newest K unnamed revisions regardless of age", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const v2 = saveFlowVersion(opened.db, flow.id, graphWith("a"), "v2");
    saveFlowVersion(opened.db, flow.id, graphWith("b"), "v3");
    ageOutRow(opened.db, v2.flowVersionId, 999);

    gcFlowVersions(opened.db, flow.id, { keepNewest: 50, olderThanDays: 0 });
    expect(opened.db.select().from(flowVersions).where(eq(flowVersions.id, v2.flowVersionId)).get()).toBeDefined();
  });

  it("keeps a revision younger than the age threshold even if beyond K", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const v2 = saveFlowVersion(opened.db, flow.id, graphWith("a"), "v2");
    saveFlowVersion(opened.db, flow.id, graphWith("b"), "v3");
    // v2 is fresh (createdAt ~ now), not aged out.

    gcFlowVersions(opened.db, flow.id, { keepNewest: 0, olderThanDays: 30 });
    expect(opened.db.select().from(flowVersions).where(eq(flowVersions.id, v2.flowVersionId)).get()).toBeDefined();
  });

  it("collects an unnamed, unreferenced, old, beyond-K revision and cascades its state_decls", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const v2 = saveFlowVersion(opened.db, flow.id, graphWith("a"), "v2");
    saveFlowVersion(opened.db, flow.id, graphWith("b"), "v3");
    ageOutRow(opened.db, v2.flowVersionId, 999);

    const result = gcFlowVersions(opened.db, flow.id, { keepNewest: 0, olderThanDays: 30 });
    expect(result.deleted).toBe(1);
    expect(opened.db.select().from(flowVersions).where(eq(flowVersions.id, v2.flowVersionId)).get()).toBeUndefined();
  });

  it("is a no-op for an unknown flow", () => {
    expect(gcFlowVersions(opened.db, "nope")).toEqual({ flowId: "nope", deleted: 0 });
  });
});
