import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

/** Pins per-region scope analysis + in-arrow `let` hoisting (PLAN-SUBGRAPH-BODIES.md): a Loop
 *  whose body is `router -> {x, y} -> merge`. The router's port is deliberately named "input" —
 *  set as the Loop's `accPortName` — so the router (a fixed single input port named "input")
 *  can serve as the body's entry node. Only "x" is ever taken (its case matches the seed value),
 *  so "y" must never be dispatched (and needs no mock response) for this fixture to pass. */
export const loopRouterBodyGraph: FlowGraph = {
  nodes: [
    {
      id: "l",
      type: "loop",
      position: { x: 0, y: 0 },
      data: { initTemplate: "seed", accPortName: "input", stopValue: "MERGED", maxIterations: 3 },
    },
    {
      id: "r",
      type: "router",
      position: { x: 1, y: 0 },
      data: { routes: ["x", "y"], cases: [{ value: "seed", route: "x" }], defaultRoute: "y" },
      parentId: "l",
    },
    { id: "x", type: "prompt", position: { x: 2, y: 0 }, data: promptData("X:{{input}}"), parentId: "l" },
    { id: "y", type: "prompt", position: { x: 2, y: 1 }, data: promptData("Y:{{input}}"), parentId: "l" },
    { id: "merge", type: "merge", position: { x: 3, y: 0 }, data: {}, parentId: "l" },
  ],
  edges: [
    { id: "e1", source: "r", target: "x", sourceHandle: "x", targetHandle: "input" },
    { id: "e2", source: "r", target: "y", sourceHandle: "y", targetHandle: "input" },
    { id: "e3", source: "x", target: "merge", targetHandle: "in1" },
    { id: "e4", source: "y", target: "merge", targetHandle: "in2" },
  ],
  state: [],
};

export const loopRouterBodyResponses = new Map([[mockResponseKey("x@l:0", "X:seed"), "MERGED"]]);
