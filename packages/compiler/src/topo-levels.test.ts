import type { FlowGraph } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { topoLevels } from "./topo-levels.js";

function node(id: string) {
  return { id, type: "prompt" as const, position: { x: 0, y: 0 }, data: {} };
}

describe("topoLevels", () => {
  it("groups a linear chain into one node per level", () => {
    const graph: FlowGraph = {
      nodes: [node("a"), node("b")],
      edges: [{ id: "a-b", source: "a", target: "b" }],
      state: [],
    };
    expect(topoLevels(graph)).toEqual([["a"], ["b"]]);
  });

  it("groups independent nodes into the same level", () => {
    const graph: FlowGraph = { nodes: [node("a"), node("b")], edges: [], state: [] };
    const levels = topoLevels(graph);
    expect(levels).toHaveLength(1);
    expect(levels[0]).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("throws on a cycle", () => {
    const graph: FlowGraph = {
      nodes: [node("a"), node("b")],
      edges: [
        { id: "a-b", source: "a", target: "b" },
        { id: "b-a", source: "b", target: "a" },
      ],
      state: [],
    };
    expect(() => topoLevels(graph)).toThrow(/cycle/);
  });
});
