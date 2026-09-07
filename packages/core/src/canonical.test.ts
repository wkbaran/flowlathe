import { describe, expect, it } from "vitest";
import { canonicalGraphJson } from "./canonical.js";
import type { FlowEdge, FlowGraph, FlowNode } from "./graph.js";

function node(id: string, data: Record<string, unknown> = {}, parentId?: string): FlowNode {
  return { id, type: "prompt", position: { x: 0, y: 0 }, data, parentId };
}

function edge(id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string): FlowEdge {
  return { id, source, target, sourceHandle, targetHandle };
}

function graph(nodes: FlowNode[], edges: FlowEdge[]): FlowGraph {
  return { nodes, edges, state: [] };
}

describe("canonicalGraphJson", () => {
  it("is insensitive to node order", () => {
    const a = graph([node("a"), node("b")], []);
    const b = graph([node("b"), node("a")], []);
    expect(canonicalGraphJson(a)).toBe(canonicalGraphJson(b));
  });

  it("is insensitive to edge order", () => {
    const a = graph([node("a"), node("b"), node("c")], [edge("e1", "a", "b"), edge("e2", "b", "c")]);
    const b = graph([node("a"), node("b"), node("c")], [edge("e2", "b", "c"), edge("e1", "a", "b")]);
    expect(canonicalGraphJson(a)).toBe(canonicalGraphJson(b));
  });

  it("is insensitive to a re-minted edge id for the same endpoints", () => {
    const a = graph([node("a"), node("b")], [edge("edge-1", "a", "b")]);
    const b = graph([node("a"), node("b")], [edge("some-other-id", "a", "b")]);
    expect(canonicalGraphJson(a)).toBe(canonicalGraphJson(b));
  });

  it("is insensitive to data key order", () => {
    const a = graph([node("a", { x: 1, y: 2 })], []);
    const b = graph([node("a", { y: 2, x: 1 })], []);
    expect(canonicalGraphJson(a)).toBe(canonicalGraphJson(b));
  });

  it("is insensitive to state-decl order", () => {
    const a: FlowGraph = { nodes: [], edges: [], state: [{ name: "x", type: "string", merge: "replace" }, { name: "y", type: "number", merge: "replace" }] };
    const b: FlowGraph = { nodes: [], edges: [], state: [{ name: "y", type: "number", merge: "replace" }, { name: "x", type: "string", merge: "replace" }] };
    expect(canonicalGraphJson(a)).toBe(canonicalGraphJson(b));
  });

  it("detects a real content change", () => {
    const a = graph([node("a", { template: "hi" })], []);
    const b = graph([node("a", { template: "bye" })], []);
    expect(canonicalGraphJson(a)).not.toBe(canonicalGraphJson(b));
  });

  it("detects a position-only change (this is graph-level hashing, not diffing)", () => {
    const a: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [], state: [] };
    const b: FlowGraph = { nodes: [{ id: "a", type: "prompt", position: { x: 10, y: 0 }, data: {} }], edges: [], state: [] };
    expect(canonicalGraphJson(a)).not.toBe(canonicalGraphJson(b));
  });

  it("distinguishes parentId from no parentId", () => {
    const a = graph([node("a"), node("b")], []);
    const b = graph([node("a"), node("b", {}, "a")], []);
    expect(canonicalGraphJson(a)).not.toBe(canonicalGraphJson(b));
  });
});
