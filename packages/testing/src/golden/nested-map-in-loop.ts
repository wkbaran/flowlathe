import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

/** Pins the `/`-joined multi-level activation key format (PLAN-SUBGRAPH-BODIES.md): a Loop
 *  whose body node is itself a Map with its own body — the opposite nesting order from
 *  `map-fanout.ts`'s single-level case. Stops after exactly one outer iteration: the Map's
 *  JSON-stringified results happen to equal the Loop's `stopValue`. */
export const nestedMapInLoopGraph: FlowGraph = {
  nodes: [
    {
      id: "l",
      type: "loop",
      position: { x: 0, y: 0 },
      data: { initTemplate: "0", accPortName: "acc", stopValue: '["LX","LY"]', maxIterations: 2 },
    },
    {
      id: "m",
      type: "map",
      position: { x: 1, y: 0 },
      data: { itemsTemplate: '["{{acc}}-x","{{acc}}-y"]', itemPortName: "item", maxConcurrency: 2, maxItems: 10 },
      parentId: "l",
    },
    { id: "leaf", type: "prompt", position: { x: 2, y: 0 }, data: promptData("{{item}}"), parentId: "m" },
  ],
  edges: [],
  state: [],
};

export const nestedMapInLoopResponses = new Map([
  [mockResponseKey("leaf@l:0/m:0", "0-x"), "LX"],
  [mockResponseKey("leaf@l:0/m:1", "0-y"), "LY"],
]);
