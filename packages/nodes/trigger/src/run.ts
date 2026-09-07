import type { RuntimeHost } from "@flowlathe/core";
import type { TriggerSpec } from "./schema.js";

export interface TriggerResult {
  content: string;
  authorId: string;
  channelId: string;
  messageId: string;
}

/**
 * Only ever actually *dispatches* when a flow is started from the canvas (`/run`, `/step-start`)
 * — resolving to `testPayload` (empty string by default) so a flow containing a trigger is still
 * fully step-debuggable at the desk. When a flow is started by a real trigger source (Discord),
 * this node's outputs are pre-seeded directly into the `GraphEngine` before the first readiness
 * pass (see `RunGraphOptions.seed`, `packages/interpreter/src/run-graph.ts`) — this function
 * never runs at all in that case, since the node is already "resolved" by the time dispatch would
 * have been considered.
 */
export async function runTrigger(ctx: RuntimeHost, spec: TriggerSpec): Promise<TriggerResult> {
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  const start = ctx.clock.now();
  const result: TriggerResult = { content: spec.testPayload, authorId: "", channelId: "", messageId: "" };
  ctx.emit({
    kind: "node_finished",
    nodeId: spec.id,
    output: result.content,
    renderedPrompt: "",
    finishReason: "stop",
    latencyMs: ctx.clock.now() - start,
  });
  return result;
}
