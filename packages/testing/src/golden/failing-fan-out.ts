import type { FlowGraph } from "@flowlathe/core";

/** Two prompt nodes, no edges, so both land in one fan-out level in both engines
 *  (PLAN-CANCELLATION.md §5.1). `boom` rejects within the first few microtasks (right after the
 *  scheduler's semaphore acquire); `slow` is parked in an interruptible 2s sleep. Expected in
 *  both engines: `node_started` for both, `node_failed` for `boom`, `node_cancelled` for `slow`,
 *  no `node_finished` at all — this is what proves the abort actually reached the provider
 *  adapter, not just that the drain awaited it. */
export const failingFanOutGraph: FlowGraph = {
  nodes: [
    { id: "boom", type: "prompt", position: { x: 0, y: 0 }, data: { template: "FAIL: boom node exploded", providerId: "mock", modelId: "m" } },
    { id: "slow", type: "prompt", position: { x: 0, y: 1 }, data: { template: "DELAY_MS: 2000 slow node", providerId: "mock", modelId: "m" } },
  ],
  edges: [],
  state: [],
};

export const failingFanOutResponses = new Map<string, string>();
