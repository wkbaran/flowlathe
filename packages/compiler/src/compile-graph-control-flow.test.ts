import type { FlowGraph } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile-graph.js";

const providers = { mock: { kind: "mock" as const } };
const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

describe("compileGraph — router + merge", () => {
  const graph: FlowGraph = {
    nodes: [
      { id: "seed", type: "prompt", position: { x: 0, y: 0 }, data: promptData("code") },
      {
        id: "router",
        type: "router",
        position: { x: 1, y: 0 },
        data: { routes: ["code", "prose"], cases: [{ value: "code", route: "code" }], defaultRoute: "prose" },
      },
      { id: "codeAnswer", type: "prompt", position: { x: 2, y: 0 }, data: promptData("CODE: {{q}}") },
      { id: "proseAnswer", type: "prompt", position: { x: 2, y: 1 }, data: promptData("PROSE: {{q}}") },
      { id: "merge", type: "merge", position: { x: 3, y: 0 }, data: {} },
    ],
    edges: [
      { id: "e0", source: "seed", target: "router", targetHandle: "input" },
      { id: "e1", source: "router", target: "codeAnswer", sourceHandle: "code", targetHandle: "q" },
      { id: "e2", source: "router", target: "proseAnswer", sourceHandle: "prose", targetHandle: "q" },
      { id: "e3", source: "codeAnswer", target: "merge", targetHandle: "in1" },
      { id: "e4", source: "proseAnswer", target: "merge", targetHandle: "in2" },
    ],
    state: [],
  };

  it("emits an if/else chain guarding each branch, and optional chaining into merge", () => {
    const script = compileGraph(graph, { providers });
    expect(script).toContain('const n_router = await rt.route(N.n_router, { input: n_seed.output });');
    expect(script).toContain("let n_codeAnswer: Awaited<ReturnType<typeof rt.prompt>> | undefined;");
    expect(script).toContain('if (n_router.route === "code") {');
    expect(script).toContain("n_codeAnswer = await rt.prompt(N.n_codeAnswer, { q: n_router.passthrough });");
    expect(script).toContain('} else if (n_router.route === "prose") {');
    expect(script).toContain(
      "const n_merge = await rt.merge(N.n_merge, { in1: n_codeAnswer?.output, in2: n_proseAnswer?.output });",
    );
    expect(script).not.toContain("Promise.all");
  });
});

describe("compileGraph — map", () => {
  const graph: FlowGraph = {
    nodes: [
      {
        id: "m",
        type: "map",
        position: { x: 0, y: 0 },
        data: { itemsTemplate: '["x","y","z"]', itemPortName: "item", maxConcurrency: 3, maxItems: 10 },
      },
      { id: "body", type: "prompt", position: { x: 1, y: 0 }, data: promptData("got: {{item}}"), parentId: "m" },
    ],
    edges: [],
    state: [],
  };

  it("emits an inlined rt.map call referencing the body node's spec", () => {
    const script = compileGraph(graph, { providers });
    expect(script).toContain("const n_m = await rt.map(N.n_m, {  }, async (item, i) => {");
    expect(script).toContain(
      "const bodyResult = await rt.prompt({ ...N.n_body, id: `body@m:${i}` }, { item: item });",
    );
    expect(script).toContain("return bodyResult.output;");
    // the body node's own spec must still be emitted into N, even though it's excluded from the outer walk
    expect(script).toContain("n_body:");
  });
});
