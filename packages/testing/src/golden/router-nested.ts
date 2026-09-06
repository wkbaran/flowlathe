import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

/**
 * A router (`innerRouter`) nested inside one branch of an outer router, with its own
 * reconvergence (`innerMerge`) still inside the outer branch, feeding a downstream node
 * (`innerFinal`) that must land at the *outer* branch's scope — not the inner router's — before
 * everything reconverges again at `outerMerge`. Exercises scope composition/collapse at two
 * nesting levels in one fixture: `innerX`/`innerY` at depth 2 (outer guard + inner guard),
 * `innerMerge`/`innerFinal` collapsing back to depth 1 (outer guard only), `outerMerge`/
 * `finalConsumer` collapsing all the way to depth 0 (unconditional).
 */
export const routerNestedGraph: FlowGraph = {
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

export const routerNestedResponses = new Map([
  [mockResponseKey("seed", "a"), "a"],
  [mockResponseKey("innerX", "INNERX: a"), "INNERX_RESULT"],
  [mockResponseKey("innerFinal", "IF: INNERX_RESULT"), "INNERFINAL_RESULT"],
  [mockResponseKey("finalConsumer", "DONE: INNERFINAL_RESULT"), "ALL_DONE"],
]);
