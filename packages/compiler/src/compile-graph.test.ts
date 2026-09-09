import type { FlowGraph } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile-graph.js";

describe("compileGraph", () => {
  it("emits a script for a two-node chain that awaits sequentially", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "start", providerId: "mock", modelId: "m" } },
        { id: "b", type: "prompt", position: { x: 1, y: 0 }, data: { template: "next: {{input}}", providerId: "mock", modelId: "m" } },
      ],
      edges: [{ id: "a-b", source: "a", target: "b", targetHandle: "input" }],
      state: [],
    };
    const script = compileGraph(graph, { providers: { mock: { kind: "mock" } } });
    expect(script).toContain("MockProviderAdapter");
    expect(script).toContain('const n_a = await rt.prompt(N.n_a, {  });');
    expect(script).toContain('const n_b = await rt.prompt(N.n_b, { input: n_a.output });');
    expect(script).toContain("rt.finish({ n_b: n_b.output });");
  });

  it("binds a Prompt template variable with no wired edge, matching a declared state entry, to an inline state.read call (PLAN-STATE-FILES.md)", () => {
    const graph: FlowGraph = {
      nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "notes: {{notes}}", providerId: "mock", modelId: "m" } }],
      edges: [],
      state: [{ name: "notes", type: "string", merge: "replace", initial: "hi" }],
    };
    const script = compileGraph(graph, { providers: { mock: { kind: "mock" } } });
    expect(script).toContain('const n_a = await rt.prompt(N.n_a, { notes: String(state.read("notes")) });');
  });

  it("embeds the declared file-backed state entry names as REQUIRED_FILE_STATE_ENTRIES, empty for a flow with none", () => {
    const graph: FlowGraph = {
      nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "hi", providerId: "mock", modelId: "m" } }],
      edges: [],
      state: [],
    };
    const script = compileGraph(graph, { providers: { mock: { kind: "mock" } } });
    expect(script).toContain("const REQUIRED_FILE_STATE_ENTRIES = [];");
  });

  it("embeds a non-empty REQUIRED_FILE_STATE_ENTRIES and a refusal guard when the flow declares a type:\"file\" entry", () => {
    const graph: FlowGraph = {
      nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "notes: {{notes}}", providerId: "mock", modelId: "m" } }],
      edges: [],
      state: [{ name: "notes", type: "file", merge: "replace", fileMode: "read-write", filePath: "notes.md" }],
    };
    const script = compileGraph(graph, { providers: { mock: { kind: "mock" } } });
    expect(script).toContain('const REQUIRED_FILE_STATE_ENTRIES = ["notes"];');
    expect(script).toContain("not supported in exported scripts");
  });

  it("emits an allOrCancel for a fan-out level", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "a", providerId: "mock", modelId: "m" } },
        { id: "b", type: "prompt", position: { x: 0, y: 1 }, data: { template: "b", providerId: "mock", modelId: "m" } },
      ],
      edges: [],
      state: [],
    };
    const script = compileGraph(graph, { providers: { mock: { kind: "mock" } } });
    expect(script).toContain("await allOrCancel(rt.cancellation, [");
  });
});
