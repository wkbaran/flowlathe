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
      'const bodyResult = await rt.prompt({ ...N.n_body, id: `body@m:${i}`, contextNodeId: "body" }, { item: item });',
    );
    expect(script).toContain("return bodyResult.output;");
    // the body node's own spec must still be emitted into N, even though it's excluded from the outer walk
    expect(script).toContain("n_body:");
  });
});

describe("compileGraph — router branch guarding beyond one hop", () => {
  const graph: FlowGraph = {
    nodes: [
      { id: "seed", type: "prompt", position: { x: 0, y: 0 }, data: promptData("prose") },
      {
        id: "router",
        type: "router",
        position: { x: 1, y: 0 },
        data: {
          routes: ["code", "prose"],
          cases: [
            { value: "code", route: "code" },
            { value: "prose", route: "prose" },
          ],
        },
      },
      { id: "codeAnswer", type: "prompt", position: { x: 2, y: 0 }, data: promptData("CODE: {{q}}") },
      { id: "codeRefine", type: "prompt", position: { x: 3, y: 0 }, data: promptData("REFINE: {{c}}") },
      { id: "codeFinal", type: "prompt", position: { x: 4, y: 0 }, data: promptData("FINAL: {{c}}") },
      { id: "proseAnswer", type: "prompt", position: { x: 2, y: 1 }, data: promptData("PROSE: {{q}}") },
      { id: "merge", type: "merge", position: { x: 5, y: 0 }, data: {} },
      { id: "final", type: "prompt", position: { x: 6, y: 0 }, data: promptData("DONE: {{m}}") },
    ],
    edges: [
      { id: "e0", source: "seed", target: "router", targetHandle: "input" },
      { id: "e1", source: "router", target: "codeAnswer", sourceHandle: "code", targetHandle: "q" },
      { id: "e2", source: "router", target: "proseAnswer", sourceHandle: "prose", targetHandle: "q" },
      { id: "e3", source: "codeAnswer", target: "codeRefine", targetHandle: "c" },
      { id: "e4", source: "codeRefine", target: "codeFinal", targetHandle: "c" },
      { id: "e5", source: "codeFinal", target: "merge", targetHandle: "in1" },
      { id: "e6", source: "proseAnswer", target: "merge", targetHandle: "in2" },
      { id: "e7", source: "merge", target: "final", targetHandle: "m" },
    ],
    state: [],
  };

  it("hoists every node in the branch (not just the direct target) and assigns them inside the guard", () => {
    const script = compileGraph(graph, { providers });
    // hoisted up front, before any if/else — including nodes 2 and 3 hops from the router
    expect(script).toContain("let n_codeAnswer: Awaited<ReturnType<typeof rt.prompt>> | undefined;");
    expect(script).toContain("let n_codeRefine: Awaited<ReturnType<typeof rt.prompt>> | undefined;");
    expect(script).toContain("let n_codeFinal: Awaited<ReturnType<typeof rt.prompt>> | undefined;");
    // bare assignments (no let/const) inside the guard, chained in topological order
    expect(script).toContain('if (n_router.route === "code") {');
    expect(script).toContain("n_codeAnswer = await rt.prompt(N.n_codeAnswer, { q: n_router.passthrough });");
    expect(script).toContain("n_codeRefine = await rt.prompt(N.n_codeRefine, { c: n_codeAnswer?.output });");
    expect(script).toContain("n_codeFinal = await rt.prompt(N.n_codeFinal, { c: n_codeRefine?.output });");
    // reconvergence still reads both sides optionally, unconditional itself
    expect(script).toContain(
      "const n_merge = await rt.merge(N.n_merge, { in1: n_codeFinal?.output, in2: n_proseAnswer?.output });",
    );
    // a consumer *after* the merge is unconditional and reads it plainly — not `?.`
    expect(script).toContain("const n_final = await rt.prompt(N.n_final, { m: n_merge.output });");
  });
});

describe("compileGraph — router nested inside another router's branch", () => {
  const graph: FlowGraph = {
    nodes: [
      { id: "seed", type: "prompt", position: { x: 0, y: 0 }, data: promptData("a") },
      {
        id: "outerRouter",
        type: "router",
        position: { x: 1, y: 0 },
        data: {
          routes: ["a", "b"],
          cases: [
            { value: "a", route: "a" },
            { value: "b", route: "b" },
          ],
        },
      },
      {
        id: "innerRouter",
        type: "router",
        position: { x: 2, y: 0 },
        data: {
          routes: ["x", "y"],
          cases: [
            { value: "a", route: "x" },
            { value: "other", route: "y" },
          ],
        },
      },
      { id: "innerX", type: "prompt", position: { x: 3, y: 0 }, data: promptData("INNERX: {{v}}") },
      { id: "innerY", type: "prompt", position: { x: 3, y: 1 }, data: promptData("INNERY: {{v}}") },
      { id: "innerMerge", type: "merge", position: { x: 4, y: 0 }, data: {} },
      { id: "innerFinal", type: "prompt", position: { x: 5, y: 0 }, data: promptData("IF: {{v}}") },
      { id: "otherBranch", type: "prompt", position: { x: 2, y: 2 }, data: promptData("OTHER: {{v}}") },
      { id: "outerMerge", type: "merge", position: { x: 6, y: 0 }, data: {} },
      { id: "finalConsumer", type: "prompt", position: { x: 7, y: 0 }, data: promptData("DONE: {{v}}") },
    ],
    edges: [
      { id: "e0", source: "seed", target: "outerRouter", targetHandle: "input" },
      { id: "e1", source: "outerRouter", target: "innerRouter", sourceHandle: "a", targetHandle: "input" },
      { id: "e2", source: "outerRouter", target: "otherBranch", sourceHandle: "b", targetHandle: "v" },
      { id: "e3", source: "innerRouter", target: "innerX", sourceHandle: "x", targetHandle: "v" },
      { id: "e4", source: "innerRouter", target: "innerY", sourceHandle: "y", targetHandle: "v" },
      { id: "e5", source: "innerX", target: "innerMerge", targetHandle: "in1" },
      { id: "e6", source: "innerY", target: "innerMerge", targetHandle: "in2" },
      { id: "e7", source: "innerMerge", target: "innerFinal", targetHandle: "v" },
      { id: "e8", source: "innerFinal", target: "outerMerge", targetHandle: "in1" },
      { id: "e9", source: "otherBranch", target: "outerMerge", targetHandle: "in2" },
      { id: "e10", source: "outerMerge", target: "finalConsumer", targetHandle: "v" },
    ],
    state: [],
  };

  it("nests the inner router's if/else inside the outer branch, with its own reconvergence still inside", () => {
    const script = compileGraph(graph, { providers });
    // the inner router itself is nested (hoisted, bare-assigned inside the outer branch)
    expect(script).toContain("let n_innerRouter: Awaited<ReturnType<typeof rt.route>> | undefined;");
    expect(script).toContain('if (n_outerRouter.route === "a") {');
    expect(script).toContain("n_innerRouter = await rt.route(N.n_innerRouter, { input: n_outerRouter.passthrough });");
    // the inner router's own branches nest one level deeper still
    expect(script).toContain('if (n_innerRouter.route === "x") {');
    expect(script).toContain("n_innerX = await rt.prompt(N.n_innerX, { v: n_innerRouter?.passthrough });");
    expect(script).toContain('} else if (n_innerRouter.route === "y") {');
    // the inner reconvergence (innerMerge) and its consumer (innerFinal) sit back at the OUTER
    // branch's level — after the inner if/else closes, but still inside the outer `if`
    expect(script).toContain(
      "n_innerMerge = await rt.merge(N.n_innerMerge, { in1: n_innerX?.output, in2: n_innerY?.output });",
    );
    expect(script).toContain("n_innerFinal = await rt.prompt(N.n_innerFinal, { v: n_innerMerge?.output });");
    // the outer reconvergence and its consumer are fully unconditional
    expect(script).toContain(
      "const n_outerMerge = await rt.merge(N.n_outerMerge, { in1: n_innerFinal?.output, in2: n_otherBranch?.output });",
    );
    expect(script).toContain("const n_finalConsumer = await rt.prompt(N.n_finalConsumer, { v: n_outerMerge.output });");
  });
});
