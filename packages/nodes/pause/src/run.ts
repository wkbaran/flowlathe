import { nodeFailureEvent, type RuntimeHost } from "@flowlathe/core";
import type { PauseSpec } from "./schema.js";

export interface PauseResult {
  output: string;
}

/**
 * Suspends until externally resumed, then passes its input straight through — so a Pause node
 * can sit inline in a chain. `spec.id` is the suspend key: the interpreter rewrites it to the
 * full activation key for scoped (Map/Loop) instances, so concurrent iterations don't collide.
 * `ctx.suspend` rejects if the run is cancelled while this node is parked (a sibling elsewhere
 * failed) — the try/catch turns that into `node_cancelled` rather than an unhandled rejection.
 */
export async function runPause(
  ctx: RuntimeHost,
  spec: PauseSpec,
  inputs: Record<string, string>,
): Promise<PauseResult> {
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  try {
    ctx.emit({
      kind: "node_suspended",
      nodeId: spec.id,
      activationKey: spec.id,
      reason: { type: "pause", message: spec.message },
    });
    await ctx.suspend(spec.id, { type: "pause", message: spec.message });
    const output = inputs["input"] ?? "";
    ctx.emit({
      kind: "node_finished",
      nodeId: spec.id,
      output,
      renderedPrompt: "",
      finishReason: "stop",
      latencyMs: 0,
    });
    return { output };
  } catch (err) {
    ctx.emit(nodeFailureEvent(spec.id, err));
    throw err;
  }
}
