import { describe, expect, it } from "vitest";
import { diffGraphs, isSemanticChange } from "./diff.js";
import type { FlowEdge, FlowGraph, FlowNode } from "./graph.js";

function node(id: string, data: Record<string, unknown> = {}, opts: { parentId?: string; x?: number; y?: number; type?: string } = {}): FlowNode {
  return { id, type: (opts.type ?? "prompt") as FlowNode["type"], position: { x: opts.x ?? 0, y: opts.y ?? 0 }, data, parentId: opts.parentId };
}

function edge(id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string): FlowEdge {
  return { id, source, target, sourceHandle, targetHandle };
}

function graph(nodes: FlowNode[], edges: FlowEdge[] = []): FlowGraph {
  return { nodes, edges, state: [] };
}

describe("diffGraphs", () => {
  it("detects an added node", () => {
    const d = diffGraphs(graph([node("a")]), graph([node("a"), node("b")]));
    expect(d.nodes.added.map((n) => n.id)).toEqual(["b"]);
    expect(d.nodes.removed).toEqual([]);
    expect(isSemanticChange(d)).toBe(true);
  });

  it("detects a removed node", () => {
    const d = diffGraphs(graph([node("a"), node("b")]), graph([node("a")]));
    expect(d.nodes.removed.map((n) => n.id)).toEqual(["b"]);
    expect(isSemanticChange(d)).toBe(true);
  });

  it("detects a per-field data change", () => {
    const d = diffGraphs(graph([node("a", { model: "gpt-4" })]), graph([node("a", { model: "gpt-5" })]));
    expect(d.nodes.changed).toHaveLength(1);
    expect(d.nodes.changed[0]!.fields).toEqual([{ path: "data.model", before: "gpt-4", after: "gpt-5" }]);
    expect(isSemanticChange(d)).toBe(true);
  });

  it("diffs a multi-line template field by line", () => {
    const before = "line1\nline2\nline3";
    const after = "line1\nCHANGED\nline3";
    const d = diffGraphs(graph([node("a", { template: before })]), graph([node("a", { template: after })]));
    const field = d.nodes.changed[0]!.fields[0]!;
    expect(field.path).toBe("data.template");
    expect(field.lineDiff).toEqual([
      { kind: "same", line: "line1" },
      { kind: "removed", line: "line2" },
      { kind: "added", line: "CHANGED" },
      { kind: "same", line: "line3" },
    ]);
  });

  it("treats a position-only change as non-semantic", () => {
    const d = diffGraphs(graph([node("a", {}, { x: 0, y: 0 })]), graph([node("a", {}, { x: 50, y: 0 })]));
    expect(d.nodes.changed[0]!.movedTo).toEqual({ x: 50, y: 0 });
    expect(d.nodes.changed[0]!.fields).toEqual([]);
    expect(isSemanticChange(d)).toBe(false);
  });

  it("detects a reparent (move into a Loop/Map body) as semantic even with no field changes", () => {
    const d = diffGraphs(graph([node("a"), node("loop1", {}, { type: "loop" })]), graph([node("a", {}, { parentId: "loop1" }), node("loop1", {}, { type: "loop" })]));
    const changed = d.nodes.changed.find((c) => c.id === "a")!;
    expect(changed.reparented).toEqual({ to: "loop1" });
    expect(isSemanticChange(d)).toBe(true);
  });

  it("detects an edge handle change as removed+added, not a change entry", () => {
    const before = graph([node("a"), node("b")], [edge("e1", "a", "b", "out", "input")]);
    const after = graph([node("a"), node("b")], [edge("e1", "a", "b", "out", "ctx")]);
    const d = diffGraphs(before, after);
    expect(d.edges.removed).toHaveLength(1);
    expect(d.edges.added).toHaveLength(1);
    expect(d.edges.removed[0]!.targetHandle).toBe("input");
    expect(d.edges.added[0]!.targetHandle).toBe("ctx");
    expect(isSemanticChange(d)).toBe(true);
  });

  it("does not treat a re-minted edge id for the same endpoints as a change", () => {
    const before = graph([node("a"), node("b")], [edge("edge-1", "a", "b")]);
    const after = graph([node("a"), node("b")], [edge("edge-2", "a", "b")]);
    const d = diffGraphs(before, after);
    expect(d.edges.added).toEqual([]);
    expect(d.edges.removed).toEqual([]);
    expect(isSemanticChange(d)).toBe(false);
  });

  it("diffs state decl added/removed/changed", () => {
    const before: FlowGraph = { nodes: [], edges: [], state: [{ name: "count", type: "number", merge: "numeric-add" }] };
    const after: FlowGraph = { nodes: [], edges: [], state: [{ name: "count", type: "number", merge: "replace" }, { name: "log", type: "array", merge: "append" }] };
    const d = diffGraphs(before, after);
    expect(d.state.added.map((s) => s.name)).toEqual(["log"]);
    expect(d.state.changed).toEqual([{ name: "count", fields: [{ path: "merge", before: "numeric-add", after: "replace" }] }]);
    expect(isSemanticChange(d)).toBe(true);
  });

  it("reports no changes for an identical graph", () => {
    const g = graph([node("a", { template: "hi" })], [edge("e1", "a", "a")]);
    const d = diffGraphs(g, g);
    expect(d.nodes.added).toEqual([]);
    expect(d.nodes.removed).toEqual([]);
    expect(d.nodes.changed).toEqual([]);
    expect(d.edges.added).toEqual([]);
    expect(d.edges.removed).toEqual([]);
    expect(isSemanticChange(d)).toBe(false);
  });
});
