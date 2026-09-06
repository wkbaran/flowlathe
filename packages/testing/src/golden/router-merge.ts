import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

export const routerMergeGraph: FlowGraph = {
  nodes: [
    { id: "seed", type: "prompt", position: { x: 0, y: 0 }, data: promptData("code") },
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
};

export const routerMergeResponses = new Map([
  [mockResponseKey("seed", "code"), "code"],
  [mockResponseKey("codeAnswer", "CODE: code"), "CODE_RESULT"],
]);
