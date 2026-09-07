import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

/**
 * PLAN-LOOPMAP-BRANCH-SKIP.md: a Map fed only from a router branch that ISN'T taken must be
 * skipped, not dispatched with "" substituted for its missing "{{input}}". The Map sits
 * deliberately on the **untaken** route "b" (the seed picks "a") — putting it on the taken side
 * would let a broken implementation pass coincidentally (CLAUDE.md's `router-deep-branch`
 * precedent). `itemsTemplate` is deliberately `["{{input}}"]` rather than the bare crash form
 * `"{{input}}"` — with the array wrapper, the pre-fix interpreter *completes* (parses `[""]` as a
 * one-item array and dispatches the body once) instead of throwing, so the pre-fix failure shows
 * up as a genuine `node_finished` trace divergence against the (always-correct) compiled script,
 * pinning "these nodes must not run at all" rather than just "this doesn't crash".
 */
export const routerUntakenMapGraph: FlowGraph = {
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
      id: "m",
      type: "map",
      position: { x: 2, y: 1 },
      data: { itemsTemplate: '["{{input}}"]', itemPortName: "item", maxConcurrency: 2, maxItems: 10 },
    },
    { id: "body", type: "prompt", position: { x: 3, y: 1 }, data: promptData("got: {{item}}"), parentId: "m" },
  ],
  edges: [
    { id: "e0", source: "seed", target: "router", targetHandle: "input" },
    { id: "e1", source: "router", target: "takenAnswer", sourceHandle: "a", targetHandle: "q" },
    { id: "e2", source: "router", target: "m", sourceHandle: "b", targetHandle: "input" },
  ],
  state: [],
};

export const routerUntakenMapResponses = new Map([
  [mockResponseKey("seed", "a"), "a"],
  [mockResponseKey("takenAnswer", "TAKEN: a"), "TAKEN_RESULT"],
  // Pre-fix only: route "b" is untaken, so m's "input" port is a never slot; the pre-fix
  // dispatchLoopOrMap coerces that to "" regardless, rendering itemsTemplate as `[""]` and
  // dispatching the body once with item="". Registering this key lets the pre-fix run reach
  // completion (rather than throwing) so the bug shows up as a trace divergence. Post-fix this
  // key is never consulted — m is skipped before dispatchLoopOrMap ever runs.
  [mockResponseKey("body@m:0", "got: "), "SHOULD_NOT_RUN"],
]);
