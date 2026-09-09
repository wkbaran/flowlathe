import { describe, expect, it } from "vitest";
import type { FlowEdge, FlowGraph, FlowNode } from "./graph.js";
import { regions, terminalNodeIds, validateGraph } from "./regions.js";
import type { StateDecl } from "./state.js";

function node(id: string, type: string, data: Record<string, unknown> = {}, parentId?: string): FlowNode {
  return { id, type: type as FlowNode["type"], position: { x: 0, y: 0 }, data, parentId };
}

function edge(id: string, source: string, target: string, sourceHandle?: string, targetHandle?: string): FlowEdge {
  return { id, source, target, sourceHandle, targetHandle };
}

function graph(nodes: FlowNode[], edges: FlowEdge[], state: StateDecl[] = []): FlowGraph {
  return { nodes, edges, state };
}

const portsOf = (n: FlowNode): string[] => {
  const p = (n.data as { ports?: string[] }).ports;
  return p ?? [];
};

describe("regions", () => {
  it("puts parentId-less nodes in the top-level region", () => {
    const g = graph([node("a", "prompt"), node("b", "prompt")], [edge("e1", "a", "b")]);
    const rs = regions(g);
    const top = rs.get("");
    expect(top?.nodeIds.sort()).toEqual(["a", "b"]);
    expect(top?.edgeIds).toEqual(["e1"]);
  });

  it("groups nodes sharing a parentId into one region keyed by that owner", () => {
    const g = graph(
      [node("m", "map", { itemPortName: "item" }), node("a", "prompt", {}, "m"), node("b", "prompt", {}, "m")],
      [edge("e1", "a", "b")],
    );
    const rs = regions(g);
    const body = rs.get("m");
    expect(body?.nodeIds.sort()).toEqual(["a", "b"]);
    expect(body?.edgeIds).toEqual(["e1"]);
  });

  it("excludes boundary-crossing edges from every region", () => {
    const g = graph(
      [node("m", "map", { itemPortName: "item" }), node("outer", "prompt"), node("a", "prompt", {}, "m")],
      [edge("e1", "outer", "a")],
    );
    const rs = regions(g);
    expect(rs.get("")?.edgeIds).toEqual([]);
    expect(rs.get("m")?.edgeIds).toEqual([]);
  });
});

describe("terminalNodeIds", () => {
  it("returns the single node with no outgoing in-region edge", () => {
    const g = graph(
      [node("m", "map", { itemPortName: "item" }), node("a", "prompt", {}, "m"), node("b", "prompt", {}, "m")],
      [edge("e1", "a", "b")],
    );
    expect(terminalNodeIds(g, "m")).toEqual(["b"]);
  });

  it("returns every leaf when a body fans out to more than one", () => {
    const g = graph(
      [node("m", "map", { itemPortName: "item" }), node("a", "prompt", {}, "m"), node("b", "prompt", {}, "m"), node("c", "prompt", {}, "m")],
      [edge("e1", "a", "b"), edge("e2", "a", "c")],
    );
    expect(terminalNodeIds(g, "m").sort()).toEqual(["b", "c"]);
  });

  it("degenerate single-node body is both entry and terminal", () => {
    const g = graph([node("m", "map", { itemPortName: "item" }), node("a", "prompt", {}, "m")], []);
    expect(terminalNodeIds(g, "m")).toEqual(["a"]);
  });
});

describe("validateGraph", () => {
  it("happy path: single-node body is valid", () => {
    const g = graph(
      [node("m", "map", { itemPortName: "item" }, undefined), node("a", "prompt", { ports: ["item"] }, "m")],
      [],
    );
    expect(validateGraph(g, { portsOf })).toEqual([]);
  });

  it("happy path: nested regions (loop inside a map body)", () => {
    const g = graph(
      [
        node("m", "map", { itemPortName: "item" }),
        node("l", "loop", { accPortName: "acc", initTemplate: "{{item}}", ports: ["item"] }, "m"),
        node("body", "prompt", { ports: ["acc"] }, "l"),
      ],
      [],
    );
    expect(validateGraph(g, { portsOf })).toEqual([]);
  });

  it("happy path: router+merge body", () => {
    const g = graph(
      [
        node("m", "map", { itemPortName: "item" }),
        node("r", "router", { ports: ["item"] }, "m"),
        node("x", "prompt", { ports: ["input"] }, "m"),
        node("y", "prompt", { ports: ["input"] }, "m"),
        node("merge", "merge", { ports: [] }, "m"),
      ],
      [
        edge("e1", "r", "x", "route1", "input"),
        edge("e2", "r", "y", "route2", "input"),
        edge("e3", "x", "merge", "output", "in1"),
        edge("e4", "y", "merge", "output", "in2"),
      ],
    );
    expect(validateGraph(g, { portsOf })).toEqual([]);
  });

  it("R1: parentId names a nonexistent node", () => {
    const g = graph([node("a", "prompt", {}, "ghost")], []);
    expect(validateGraph(g)).toEqual([expect.stringContaining('parentId "ghost"')]);
  });

  it("R2: parentId target isn't a loop/map", () => {
    const g = graph([node("p", "prompt"), node("a", "prompt", {}, "p")], []);
    expect(validateGraph(g)).toEqual([expect.stringContaining('is a "prompt" node, not a loop/map')]);
  });

  it("R3: a loop/map node with no body node", () => {
    const g = graph([node("m", "map", { itemPortName: "item" })], []);
    expect(validateGraph(g)).toEqual([expect.stringContaining("has no body node")]);
  });

  it("R4: outer -> body edge is an error", () => {
    const g = graph(
      [node("m", "map", { itemPortName: "item" }), node("outer", "prompt"), node("a", "prompt", { ports: ["item"] }, "m")],
      [edge("e1", "outer", "a")],
    );
    const problems = validateGraph(g, { portsOf });
    expect(problems.some((p) => p.includes("crosses into a Loop/Map body"))).toBe(true);
  });

  it("R4: body -> outer edge is an error", () => {
    const g = graph(
      [node("m", "map", { itemPortName: "item" }), node("a", "prompt", { ports: ["item"] }, "m"), node("outer", "prompt", { ports: ["input"] })],
      [edge("e1", "a", "outer", "output", "input")],
    );
    const problems = validateGraph(g, { portsOf });
    expect(problems.some((p) => p.includes("crosses out of a Loop/Map body"))).toBe(true);
  });

  it("R4: edge between two different bodies is an error", () => {
    const g = graph(
      [
        node("m1", "map", { itemPortName: "item" }),
        node("m2", "map", { itemPortName: "item" }),
        node("a", "prompt", { ports: ["item"] }, "m1"),
        node("b", "prompt", { ports: ["input"] }, "m2"),
      ],
      [edge("e1", "a", "b", "output", "input")],
    );
    const problems = validateGraph(g, { portsOf });
    expect(problems.some((p) => p.includes("crosses between two different Loop/Map bodies"))).toBe(true);
  });

  it("R5: a cycle within a body", () => {
    const g = graph(
      [node("m", "map", { itemPortName: "item" }), node("a", "prompt", {}, "m"), node("b", "prompt", {}, "m")],
      [edge("e1", "a", "b"), edge("e2", "b", "a")],
    );
    expect(validateGraph(g).some((p) => p.includes("contains a cycle"))).toBe(true);
  });

  it("R5: a body with more than one terminal", () => {
    const g = graph(
      [node("m", "map", { itemPortName: "item" }), node("a", "prompt", {}, "m"), node("b", "prompt", {}, "m"), node("c", "prompt", {}, "m")],
      [edge("e1", "a", "b"), edge("e2", "a", "c")],
    );
    expect(validateGraph(g).some((p) => p.includes("more than one terminal node"))).toBe(true);
  });

  it("R6: a body with no node declaring the injected port", () => {
    const g = graph(
      [node("m", "map", { itemPortName: "item" }), node("a", "prompt", { ports: [] }, "m")],
      [],
    );
    expect(validateGraph(g, { portsOf }).some((p) => p.includes('no node declaring input port "item"'))).toBe(true);
  });

  it("R7: a declared input port with no incoming edge (outside the injected exception)", () => {
    const g = graph([node("a", "prompt", { ports: ["input"] })], []);
    expect(validateGraph(g, { portsOf }).some((p) => p.includes('declares input port "input" with no incoming edge'))).toBe(
      true,
    );
  });

  it("R7 is skipped entirely when portsOf is omitted", () => {
    const g = graph([node("a", "prompt", { ports: ["input"] })], []);
    expect(validateGraph(g)).toEqual([]);
  });

  it("R7: a Prompt node's port matching a declared state entry is exempt from needing an edge (PLAN-STATE-FILES.md)", () => {
    const g = graph(
      [node("a", "prompt", { ports: ["notes"] })],
      [],
      [{ name: "notes", type: "string", merge: "replace" }],
    );
    expect(validateGraph(g, { portsOf })).toEqual([]);
  });

  it("R7: the state exemption does not apply to a non-Prompt node's port of the same name", () => {
    const g = graph(
      [node("a", "router", { ports: ["notes"] })],
      [],
      [{ name: "notes", type: "string", merge: "replace" }],
    );
    expect(validateGraph(g, { portsOf }).some((p) => p.includes('declares input port "notes" with no incoming edge'))).toBe(
      true,
    );
  });

  it("R8: a type \"file\" state decl missing filePath/fileMode is flagged", () => {
    const g = graph([node("a", "prompt", { ports: [] })], [], [{ name: "notes", type: "file", merge: "replace" } as StateDecl]);
    const problems = validateGraph(g);
    expect(problems.some((p) => p.includes('state entry "notes" has type "file" but no filePath'))).toBe(true);
    expect(problems.some((p) => p.includes('state entry "notes" has type "file" but no fileMode'))).toBe(true);
  });

  it("R8: a type \"file\" state decl with an unsupported merge rule is flagged", () => {
    const g = graph(
      [node("a", "prompt", { ports: [] })],
      [],
      [{ name: "notes", type: "file", merge: "numeric-add", filePath: "a.md", fileMode: "read-write" } as StateDecl],
    );
    expect(validateGraph(g).some((p) => p.includes('file entries only support "replace"/"append"'))).toBe(true);
  });

  it("R8: a well-formed type \"file\" state decl is not flagged", () => {
    const g = graph(
      [node("a", "prompt", { ports: [] })],
      [],
      [{ name: "notes", type: "file", merge: "append", filePath: "a.md", fileMode: "read-write" }],
    );
    expect(validateGraph(g)).toEqual([]);
  });
});
