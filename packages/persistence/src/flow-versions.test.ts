import { emptyFlowGraph, type FlowGraph } from "@flowlathe/core";
import { beforeEach, describe, expect, it } from "vitest";
import { type OpenedDb, openDb } from "./db.js";
import { startExecution } from "./executions.js";
import { labelFlowVersion, listFlowVersions } from "./flow-versions.js";
import { createFlow, saveFlowVersion } from "./flows.js";
import { runMigrations } from "./migrate.js";

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
});

describe("listFlowVersions", () => {
  it("lists newest first, marking the head", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const graph: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    const v2 = saveFlowVersion(opened.db, flow.id, graph, "v2");

    const versions = listFlowVersions(opened.db, flow.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]!.id).toBe(v2.flowVersionId);
    expect(versions[0]!.isHead).toBe(true);
    expect(versions[1]!.isHead).toBe(false);
  });

  it("counts executions per version", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    startExecution(opened.db, flow.flowVersionId, "run");
    startExecution(opened.db, flow.flowVersionId, "run");

    const versions = listFlowVersions(opened.db, flow.id);
    expect(versions[0]!.executionCount).toBe(2);
  });

  it("returns an empty array for an unknown flow", () => {
    expect(listFlowVersions(opened.db, "nope")).toEqual([]);
  });
});

describe("labelFlowVersion", () => {
  it("sets label and message on an arbitrary past revision", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const updated = labelFlowVersion(opened.db, flow.flowVersionId, "baseline", "the first cut");
    expect(updated?.label).toBe("baseline");
    expect(updated?.message).toBe("the first cut");
  });

  it("leaves message untouched when omitted", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    labelFlowVersion(opened.db, flow.flowVersionId, "baseline", "keep me");
    const updated = labelFlowVersion(opened.db, flow.flowVersionId, "renamed");
    expect(updated?.label).toBe("renamed");
    expect(updated?.message).toBe("keep me");
  });

  it("returns undefined for an unknown version id", () => {
    expect(labelFlowVersion(opened.db, "nope", "x")).toBeUndefined();
  });
});
