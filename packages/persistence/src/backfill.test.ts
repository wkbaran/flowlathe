import { emptyFlowGraph, type FlowGraph } from "@flowlathe/core";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { backfillContentHashes } from "./backfill.js";
import { type OpenedDb, openDb } from "./db.js";
import { startExecution } from "./executions.js";
import { createFlow, getFlow, getFlowVersionRow } from "./flows.js";
import { runMigrations } from "./migrate.js";
import { flowVersions, stateDecls } from "./schema.js";

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
});

/** Simulates a pre-dedup row: bypasses saveFlowVersion (which always hashes now) to insert a
 *  flow_versions row the way the old, unconditional-insert code path used to. */
function insertLegacyRow(flowId: string, version: number, graph: FlowGraph): string {
  const id = randomUUID();
  opened.db.insert(flowVersions).values({ id, flowId, version, graphJson: graph, sourceText: null, contentHash: null }).run();
  return id;
}

describe("backfillContentHashes", () => {
  it("is a no-op when every row already has a hash (runMigrations already ran it once)", () => {
    createFlow(opened.db, "My Flow", emptyFlowGraph());
    expect(backfillContentHashes(opened.db)).toEqual({ hashed: 0, collapsed: 0 });
  });

  it("hashes a single unhashed row without deleting anything", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    const legacyId = insertLegacyRow(flow.id, 2, graph);

    const result = backfillContentHashes(opened.db);
    expect(result).toEqual({ hashed: 1, collapsed: 0 });
    const row = getFlowVersionRow(opened.db, legacyId);
    expect(row?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("collapses unreferenced exact duplicates, keeping one", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    const dup1 = insertLegacyRow(flow.id, 2, graph);
    const dup2 = insertLegacyRow(flow.id, 3, graph);
    const dup3 = insertLegacyRow(flow.id, 4, graph);

    const result = backfillContentHashes(opened.db);
    expect(result).toEqual({ hashed: 1, collapsed: 2 });

    const survivors = [dup1, dup2, dup3].filter((id) => getFlowVersionRow(opened.db, id) !== undefined);
    expect(survivors).toHaveLength(1);
    expect(getFlowVersionRow(opened.db, survivors[0]!)?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never deletes a duplicate row an execution references", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    const dup1 = insertLegacyRow(flow.id, 2, graph);
    const dup2 = insertLegacyRow(flow.id, 3, graph);
    startExecution(opened.db, dup2, "run");

    const result = backfillContentHashes(opened.db);
    expect(result.collapsed).toBe(1);
    expect(getFlowVersionRow(opened.db, dup1)).toBeUndefined();
    expect(getFlowVersionRow(opened.db, dup2)).toBeDefined();
  });

  it("cascades state_decls when a duplicate row is deleted", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph: FlowGraph = { nodes: [], edges: [], state: [] };
    const dup1 = insertLegacyRow(flow.id, 2, graph);
    const dup2 = insertLegacyRow(flow.id, 3, graph);
    opened.db.insert(stateDecls).values({ flowVersionId: dup1, name: "x", typeJson: "string", merge: "replace" }).run();

    backfillContentHashes(opened.db);
    const remaining = opened.db.select().from(stateDecls).where(eq(stateDecls.flowVersionId, dup1)).all();
    // dup1 survives or not depending on keeper choice, but whichever row was deleted must have
    // had its state_decls deleted too — assert no orphaned state_decls row for a deleted version.
    const dup1Exists = getFlowVersionRow(opened.db, dup1) !== undefined;
    expect(remaining.length).toBe(dup1Exists ? 1 : 0);
    void dup2;
  });

  it("leaves getFlow's HEAD resolution correct after collapsing duplicates", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    insertLegacyRow(flow.id, 2, graph);
    insertLegacyRow(flow.id, 3, graph);
    backfillContentHashes(opened.db);
    expect(getFlow(opened.db, flow.id)?.graph).toEqual(graph);
  });
});
