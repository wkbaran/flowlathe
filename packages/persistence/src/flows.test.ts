import { emptyFlowGraph, type FlowGraph } from "@flowlathe/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type OpenedDb, openDb } from "./db.js";
import { createFlow, getFlow, getFlowVersionRow, listFlows, saveFlowVersion } from "./flows.js";
import { runMigrations } from "./migrate.js";

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
});

describe("flow repository", () => {
  it("creates a flow and reads it back with its graph", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const fetched = getFlow(opened.db, created.id);
    expect(fetched).toEqual(created);
  });

  it("lists created flows", () => {
    createFlow(opened.db, "Flow A", emptyFlowGraph());
    createFlow(opened.db, "Flow B", emptyFlowGraph());
    const names = listFlows(opened.db).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["Flow A", "Flow B"]));
  });

  it("bumps the version and persists a new graph on save", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph: FlowGraph = {
      nodes: [{ id: "a", type: "prompt", position: { x: 1, y: 2 }, data: {} }],
      edges: [],
      state: [],
    };
    const saved = saveFlowVersion(opened.db, created.id, graph);
    expect(saved.version).toBe(2);
    expect(getFlow(opened.db, created.id)?.graph).toEqual(graph);
  });

  it("derives a slugified id from the name by default", () => {
    const created = createFlow(opened.db, "Research Brief!", emptyFlowGraph());
    expect(created.id).toBe("research-brief");
  });

  it("suffixes on a name collision", () => {
    const a = createFlow(opened.db, "Research Brief", emptyFlowGraph());
    const b = createFlow(opened.db, "Research Brief", emptyFlowGraph());
    expect(a.id).toBe("research-brief");
    expect(b.id).toBe("research-brief-2");
  });

  it("accepts an explicit id override", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph(), { id: "custom-id" });
    expect(created.id).toBe("custom-id");
  });

  it("saving with the same sourceText creates no new version (content-hash dedup)", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph: FlowGraph = {
      nodes: [{ id: "a", type: "prompt", position: { x: 1, y: 2 }, data: {} }],
      edges: [],
      state: [],
    };
    const first = saveFlowVersion(opened.db, created.id, graph, "flow \"my-flow\" {}\n");
    const second = saveFlowVersion(opened.db, created.id, graph, "flow \"my-flow\" {}\n");
    expect(second.version).toBe(first.version);
    expect(second.flowVersionId).toBe(first.flowVersionId);
  });

  it("saving with different sourceText bumps the version", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph = emptyFlowGraph();
    const first = saveFlowVersion(opened.db, created.id, graph, "flow \"my-flow\" {}\n");
    const second = saveFlowVersion(opened.db, created.id, graph, "flow \"my-flow\" { }\n");
    expect(second.version).toBe(first.version + 1);
    expect(second.flowVersionId).not.toBe(first.flowVersionId);
  });

  it("saving without sourceText still dedups, via canonicalGraphJson (PLAN-FLOW-VERSIONING.md §4.1)", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph = emptyFlowGraph();
    const first = saveFlowVersion(opened.db, created.id, graph);
    const second = saveFlowVersion(opened.db, created.id, graph);
    expect(second.version).toBe(first.version);
    expect(second.flowVersionId).toBe(first.flowVersionId);
  });

  it("saving a different graph without sourceText bumps the version", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const first = saveFlowVersion(opened.db, created.id, emptyFlowGraph());
    const graph: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    const second = saveFlowVersion(opened.db, created.id, graph);
    expect(second.version).toBe(first.version + 1);
  });

  it("getFlowVersionRow exposes sourceText/contentHash, contentHash always populated", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const withText = saveFlowVersion(opened.db, created.id, emptyFlowGraph(), 'flow "my-flow" {}\n');
    const row = getFlowVersionRow(opened.db, withText.flowVersionId);
    expect(row?.sourceText).toBe('flow "my-flow" {}\n');
    expect(row?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const graph: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    const withoutText = saveFlowVersion(opened.db, created.id, graph);
    const row2 = getFlowVersionRow(opened.db, withoutText.flowVersionId);
    expect(row2?.sourceText).toBeNull();
    expect(row2?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("labeling an existing revision on re-save doesn't duplicate it", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph = emptyFlowGraph();
    const first = saveFlowVersion(opened.db, created.id, graph, 'flow "my-flow" {}\n');
    const labeled = saveFlowVersion(opened.db, created.id, graph, 'flow "my-flow" {}\n', { label: "baseline", message: "first cut" });
    expect(labeled.flowVersionId).toBe(first.flowVersionId);
    const row = getFlowVersionRow(opened.db, labeled.flowVersionId);
    expect(row?.label).toBe("baseline");
    expect(row?.message).toBe("first cut");
  });

  it("records parent_version_id as the prior HEAD on a normal save", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    const v2 = saveFlowVersion(opened.db, created.id, graph, "v2");
    const row = getFlowVersionRow(opened.db, v2.flowVersionId);
    expect(row?.parentVersionId).toBe(created.flowVersionId);
  });

  it("force always inserts a new row, even duplicating an existing revision's content", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    saveFlowVersion(opened.db, created.id, graph, "v2"); // HEAD is v2 now

    // Restoring back to v1's (empty) graph: without force, dedup would just hand back v1 itself,
    // leaving HEAD at v2 — a silent no-op from the restoring user's point of view.
    const restored = saveFlowVersion(opened.db, created.id, emptyFlowGraph(), "v3-restored", {
      parentVersionId: created.flowVersionId,
      force: true,
    });
    expect(restored.version).toBe(3);
    expect(restored.flowVersionId).not.toBe(created.flowVersionId);
    expect(getFlow(opened.db, created.id)?.flowVersionId).toBe(restored.flowVersionId);
  });

  it("records an explicit parent_version_id override (a restore)", () => {
    const created = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    saveFlowVersion(opened.db, created.id, graph, "v2"); // HEAD is now v2
    const graph2: FlowGraph = { nodes: [{ id: "b", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    const restored = saveFlowVersion(opened.db, created.id, graph2, "v3-restored-from-v1", { parentVersionId: created.flowVersionId });
    const row = getFlowVersionRow(opened.db, restored.flowVersionId);
    expect(row?.parentVersionId).toBe(created.flowVersionId);
  });
});
