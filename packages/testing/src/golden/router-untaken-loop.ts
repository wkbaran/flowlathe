import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

/**
 * PLAN-LOOPMAP-BRANCH-SKIP.md: a Loop fed only from a router branch that ISN'T taken must be
 * skipped, not dispatched with "" substituted for its missing "{{input}}". Same shape as
 * `router-untaken-map`, with the Loop on the untaken route "b" instead of a Map. Unlike Map's
 * `itemsTemplate`, a Loop's `initTemplate` rendering to "" doesn't crash — the pre-fix loop just
 * runs with an empty accumulator, which is the more dangerous failure mode (CLAUDE.md: "a run
 * that completes, with the untaken branch's body having really executed"). The mock response
 * below is registered as the loop's own `stopValue` so the pre-fix run terminates after one
 * iteration instead of hitting `LoopLimitExceeded` — either way it's a real, comparable trace
 * divergence against the compiled script.
 */
export const routerUntakenLoopGraph: FlowGraph = {
  nodes: [
    { id: "seed", type: "prompt", position: { x: 0, y: 0 }, data: promptData("a") },
    {
      id: "router",
      type: "router",
      position: { x: 1, y: 0 },
      data: { routes: ["a", "b"], cases: [{ value: "a", route: "a" }], defaultRoute: "b" },
    },
    { id: "takenAnswer", type: "prompt", position: { x: 2, y: 0 }, data: promptData("TAKEN: {{q}}") },
    {
      id: "l",
      type: "loop",
      position: { x: 2, y: 1 },
      data: { initTemplate: "{{input}}", accPortName: "acc", stopValue: "STOP", maxIterations: 10 },
    },
    { id: "body", type: "prompt", position: { x: 3, y: 1 }, data: promptData("{{acc}}"), parentId: "l" },
  ],
  edges: [
    { id: "e0", source: "seed", target: "router", targetHandle: "input" },
    { id: "e1", source: "router", target: "takenAnswer", sourceHandle: "a", targetHandle: "q" },
    { id: "e2", source: "router", target: "l", sourceHandle: "b", targetHandle: "input" },
  ],
  state: [],
};

export const routerUntakenLoopResponses = new Map([
  [mockResponseKey("seed", "a"), "a"],
  [mockResponseKey("takenAnswer", "TAKEN: a"), "TAKEN_RESULT"],
  // Pre-fix only: route "b" is untaken, so l's "input" port is a never slot; the pre-fix
  // dispatchLoopOrMap coerces that to "" regardless, rendering initTemplate as "" and dispatching
  // the body once with acc="". Registering this response as the loop's stopValue lets the pre-fix
  // run terminate normally after one iteration. Post-fix this key is never consulted — l is
  // skipped before dispatchLoopOrMap ever runs.
  [mockResponseKey("body@l:0", ""), "STOP"],
]);
