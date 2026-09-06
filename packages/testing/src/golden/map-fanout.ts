import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

export const mapFanoutGraph: FlowGraph = {
  nodes: [
    {
      id: "m",
      type: "map",
      position: { x: 0, y: 0 },
      data: { itemsTemplate: '["x","y","z"]', itemPortName: "item", maxConcurrency: 3, maxItems: 10 },
    },
    {
      id: "body",
      type: "prompt",
      position: { x: 1, y: 0 },
      data: { template: "got: {{item}}", providerId: "mock", modelId: "m" },
      parentId: "m",
    },
  ],
  edges: [],
};

export const mapFanoutResponses = new Map([
  [mockResponseKey("body@m:0", "got: x"), "X_RESULT"],
  [mockResponseKey("body@m:1", "got: y"), "Y_RESULT"],
  [mockResponseKey("body@m:2", "got: z"), "Z_RESULT"],
]);
