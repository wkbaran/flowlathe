import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

/**
 * A router branch that's 3 nodes deep before reconverging, plus a consumer downstream of the
 * merge — this is the exact shape that used to crash the compiled script. The deep chain
 * (`codeAnswer` -> `codeRefine` -> `codeFinal`) is deliberately on the **untaken** branch (the
 * seed picks "prose"): the old compiler only guarded nodes directly targeted by a router edge,
 * so `codeRefine`/`codeFinal` fell through to an unconditional call — reading `.output` off
 * `codeAnswer` (never assigned, since its branch didn't run) crashes at runtime. Picking the
 * *taken* branch as the deep one would miss this bug entirely, since the old code's
 * unconditional-but-coincidentally-correct execution would happen to still work whenever the
 * deep chain's own branch happens to be the one that ran.
 */
export const routerDeepBranchGraph: FlowGraph = {
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

export const routerDeepBranchResponses = new Map([
  [mockResponseKey("seed", "prose"), "prose"],
  [mockResponseKey("proseAnswer", "PROSE: prose"), "PROSE_RESULT"],
  [mockResponseKey("final", "DONE: PROSE_RESULT"), "ALL_DONE"],
]);
