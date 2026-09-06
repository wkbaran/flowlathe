import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

export const fanOutGraph: FlowGraph = {
  nodes: [
    { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "a-prompt", providerId: "mock", modelId: "m" } },
    { id: "b", type: "prompt", position: { x: 0, y: 1 }, data: { template: "b-prompt", providerId: "mock", modelId: "m" } },
  ],
  edges: [],
  state: [],
};

export const fanOutResponses = new Map([
  [mockResponseKey("a", "a-prompt"), "RESPONSE_A"],
  [mockResponseKey("b", "b-prompt"), "RESPONSE_B"],
]);
