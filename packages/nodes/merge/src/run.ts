import { nodeFailureEvent, type RuntimeHost } from "@flowlathe/core";
import type { MergeSpec } from "./schema.js";

export interface MergeResult {
  output: string;
}

/**
 * Joins a Router diamond (or any fan-in) without silently skipping: ready once both `in1` and
 * `in2` have settled to value|never, and picks whichever is present. The interpreter only calls
 * this once at least one side is a real value — if both are `never` the whole activation is
 * skipped before this runs, so a genuinely absent input here is a bug, not a normal case.
 */
export async function runMerge(
  ctx: RuntimeHost,
  spec: MergeSpec,
  inputs: Record<string, string | undefined>,
): Promise<MergeResult> {
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  const output = inputs["in1"] ?? inputs["in2"];
  if (output === undefined) {
    const err = new Error(`merge "${spec.id}" was dispatched with no input value on either side`);
    ctx.emit(nodeFailureEvent(spec.id, err));
    throw err;
  }
  ctx.emit({
    kind: "node_finished",
    nodeId: spec.id,
    output,
    renderedPrompt: "",
    finishReason: "stop",
    latencyMs: 0,
  });
  return { output };
}
