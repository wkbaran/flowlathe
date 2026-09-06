import { describe, expect, it } from "vitest";
import { emptyFlowGraph, parseFlowGraph } from "./graph.js";

describe("FlowGraph", () => {
  it("round-trips an empty graph through the schema", () => {
    const graph = emptyFlowGraph();
    expect(parseFlowGraph(graph)).toEqual(graph);
  });

  it("rejects a node missing a position", () => {
    expect(() =>
      parseFlowGraph({
        nodes: [{ id: "a", type: "prompt", data: {} }],
        edges: [],
      }),
    ).toThrow();
  });

  it("accepts a graph with a node and a connecting edge", () => {
    const graph = {
      nodes: [
        { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} },
        { id: "b", type: "prompt", position: { x: 200, y: 0 }, data: {} },
      ],
      edges: [{ id: "a-b", source: "a", target: "b" }],
    };
    expect(parseFlowGraph(graph)).toEqual({ ...graph, state: [] });
  });
});
