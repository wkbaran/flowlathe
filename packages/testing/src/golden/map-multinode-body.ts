import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

/** Pins the basic multi-node-body feature (PLAN-SUBGRAPH-BODIES.md): a Map body that's a 2-node
 *  chain (`a` -> `b`), not a single node — per-iteration scoped keys for BOTH body nodes. */
export const mapMultinodeBodyGraph: FlowGraph = {
  nodes: [
    {
      id: "m",
      type: "map",
      position: { x: 0, y: 0 },
      data: { itemsTemplate: '["x","y","z"]', itemPortName: "item", maxConcurrency: 3, maxItems: 10 },
    },
    { id: "a", type: "prompt", position: { x: 1, y: 0 }, data: promptData("{{item}}"), parentId: "m" },
    { id: "b", type: "prompt", position: { x: 2, y: 0 }, data: promptData("next: {{input}}"), parentId: "m" },
  ],
  edges: [{ id: "a-b", source: "a", target: "b", targetHandle: "input" }],
  state: [],
};

export const mapMultinodeBodyResponses = new Map([
  [mockResponseKey("a@m:0", "x"), "A_X"],
  [mockResponseKey("b@m:0", "next: A_X"), "B_X"],
  [mockResponseKey("a@m:1", "y"), "A_Y"],
  [mockResponseKey("b@m:1", "next: A_Y"), "B_Y"],
  [mockResponseKey("a@m:2", "z"), "A_Z"],
  [mockResponseKey("b@m:2", "next: A_Z"), "B_Z"],
]);
