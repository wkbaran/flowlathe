import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

export const twoNodeChainGraph: FlowGraph = {
  nodes: [
    { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "start", providerId: "mock", modelId: "m" } },
    {
      id: "b",
      type: "prompt",
      position: { x: 1, y: 0 },
      data: { template: "next: {{input}}", providerId: "mock", modelId: "m" },
    },
  ],
  edges: [{ id: "a-b", source: "a", target: "b", targetHandle: "input" }],
  state: [],
};

export const twoNodeChainResponses = new Map([
  [mockResponseKey("a", "start"), "RESPONSE_A"],
  [mockResponseKey("b", "next: RESPONSE_A"), "RESPONSE_B"],
]);
