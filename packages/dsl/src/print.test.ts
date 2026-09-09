import type { FlowGraph } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { format } from "./format.js";
import { normalizeForRoundTrip } from "./normalize.js";
import { parse } from "./parse.js";
import { print } from "./print.js";

const twoNodeChain: FlowGraph = {
  nodes: [
    { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "hi", providerId: "mock", modelId: "m" } },
    { id: "b", type: "prompt", position: { x: 1, y: 0 }, data: { template: "{{input}}", providerId: "mock", modelId: "m" } },
  ],
  edges: [{ id: "a-b", source: "a", target: "b", sourceHandle: "output", targetHandle: "input" }],
  state: [],
};

describe("print", () => {
  it("emits a parseable, canonical .flow file", () => {
    const text = print({ name: "chain", graph: twoNodeChain, comments: {} });
    expect(text).toContain('flow "chain" {');
    expect(text).toContain("node a: prompt @(0, 0) {");
    expect(text).toContain("a.output -> b.input");
    const reparsed = parse(text);
    expect(reparsed.graph).toEqual(normalizeForRoundTrip(twoNodeChain));
  });

  it("prints a multi-line template as a triple-quoted, dedented block", () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: "a",
          type: "prompt",
          position: { x: 0, y: 0 },
          data: { template: "line one\n\nline two", providerId: "mock", modelId: "m" },
        },
      ],
      edges: [],
      state: [],
    };
    const text = print({ name: "f", graph, comments: {} });
    expect(text).toContain('template = """');
    const reparsed = parse(text);
    expect(reparsed.graph.nodes[0]!.data["template"]).toBe("line one\n\nline two");
  });

  it("prints Loop/Map body nodes nested inside a body block", () => {
    const graph: FlowGraph = {
      nodes: [
        {
          id: "loop1",
          type: "loop",
          position: { x: 0, y: 0 },
          data: { initTemplate: "{{input}}", accPortName: "input", stopValue: "DONE", maxIterations: 5 },
        },
        {
          id: "body1",
          type: "prompt",
          position: { x: 1, y: 0 },
          data: { template: "{{input}}", providerId: "mock", modelId: "m" },
          parentId: "loop1",
        },
      ],
      edges: [],
      state: [],
    };
    const text = print({ name: "f", graph, comments: {} });
    expect(text).toContain("body {");
    expect(text).toContain("node body1: prompt");
    const reparsed = parse(text);
    expect(reparsed.graph.nodes.find((n) => n.id === "body1")!.parentId).toBe("loop1");
  });

  it("re-emits a leading comment above its node", () => {
    const text = print({ name: "f", graph: twoNodeChain, comments: { "node:a": "the entry point" } });
    expect(text).toContain("# the entry point\n  node a:");
  });

  it("round-trips a file-backed state decl's filePath/fileMode/versioned (PLAN-STATE-FILES.md)", () => {
    const graph: FlowGraph = {
      nodes: [],
      edges: [],
      state: [
        { name: "notes", type: "file", merge: "replace", filePath: "notes/seed.md", fileMode: "read-write", versioned: true },
      ],
    };
    const text = print({ name: "f", graph, comments: {} });
    expect(text).toContain('state notes: file merge=replace filePath="notes/seed.md" fileMode=read-write versioned=true');
    const reparsed = parse(text);
    expect(reparsed.graph.state).toEqual(graph.state);
  });

  it("round-trips a read-only file-backed state decl (versioned omitted)", () => {
    const graph: FlowGraph = {
      nodes: [],
      edges: [],
      state: [{ name: "resource", type: "file", merge: "replace", filePath: "doc.md", fileMode: "read-only" }],
    };
    const text = print({ name: "f", graph, comments: {} });
    const reparsed = parse(text);
    expect(reparsed.graph.state).toEqual(graph.state);
  });
});

describe("format idempotency", () => {
  it("format(format(s)) === format(s)", () => {
    const text = print({ name: "chain", graph: twoNodeChain, comments: {} });
    expect(format(format(text))).toBe(format(text));
  });

  it("is stable across a repeated round trip for a nested-body graph", () => {
    const source = `flow "f" {
  node m: map @(0, 0) {
    itemsTemplate = "[\\"a\\",\\"b\\"]"
    itemPortName = "item"
    maxConcurrency = 2
    maxItems = 10

    body {
      node x: prompt @(1, 0) {
        template = "{{item}}"
        providerId = "mock"
        modelId = "m"
      }
    }
  }
}
`;
    expect(format(format(source))).toBe(format(source));
  });
});
