import type { FlowGraph } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile-graph.js";

const providers = { mock: { kind: "mock" as const } };
const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

/**
 * Whole-output regression coverage for compileGraph, added before PLAN-COMPILER-VARNAME.md's
 * rewrite of `varName` into `buildVarNames` — the one function every emitted identifier flows
 * through. These two graphs have no colliding node ids, so their compiled output must be
 * byte-identical before and after that rewrite (no `-u` needed across it). This is the guarantee
 * CLAUDE.md's PLAN-SUBGRAPH-BODIES.md bullet claimed already existed ("a real regression test
 * asserts this") but didn't — see PLAN-COMPILER-VARNAME.md §2 and §4.4.
 *
 * Graphs are duplicated locally rather than imported from @flowlathe/testing's golden fixtures —
 * that package depends on @flowlathe/compiler, so the reverse import would be circular.
 */
describe("compileGraph — whole-output snapshots (pin before varName rewrite)", () => {
  it("matches the single-node Map body shape", async () => {
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
    const script = compileGraph(graph, { providers });
    await expect(script).toMatchFileSnapshot("./__snapshots__/map-single-node-body.ts.snap");
  });

  it("matches a router graph with hoisting and reconvergence", async () => {
    // Same shape as compile-graph-control-flow.test.ts's "router nested inside another router's
    // branch" fixture — exercises emitScope, the let pre-pass, and ?. accessors.
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
    const script = compileGraph(graph, { providers });
    await expect(script).toMatchFileSnapshot("./__snapshots__/router-nested.ts.snap");
  });
});
