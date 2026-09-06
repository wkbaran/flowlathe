import type { RuntimeHost } from "@flowlathe/core";
import type { UserInputSpec } from "./schema.js";

export interface UserInputResult {
  output: string;
}

/** Suspends until a human answers `spec.prompt`, then that answer becomes the node's output. */
export async function runUserInput(ctx: RuntimeHost, spec: UserInputSpec): Promise<UserInputResult> {
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  ctx.emit({
    kind: "node_suspended",
    nodeId: spec.id,
    activationKey: spec.id,
    reason: { type: "user_input", prompt: spec.prompt },
  });
  const output = await ctx.suspend(spec.id, { type: "user_input", prompt: spec.prompt });
  ctx.emit({
    kind: "node_finished",
    nodeId: spec.id,
    output,
    renderedPrompt: spec.prompt,
    finishReason: "stop",
    latencyMs: 0,
  });
  return { output };
}
