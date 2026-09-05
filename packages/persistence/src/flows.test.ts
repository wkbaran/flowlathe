import { emptyFlowGraph } from "@flowlathe/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type OpenedDb, openDb } from "./db.js";
import { createFlow, getFlow, listFlows, saveFlowVersion } from "./flows.js";
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
    const graph = { nodes: [{ id: "a", type: "prompt", position: { x: 1, y: 2 }, data: {} }], edges: [] };
    const saved = saveFlowVersion(opened.db, created.id, graph);
    expect(saved.version).toBe(2);
    expect(getFlow(opened.db, created.id)?.graph).toEqual(graph);
  });
});
