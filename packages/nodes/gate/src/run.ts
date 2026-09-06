import type { LlmConfig, RuntimeHost } from "@flowlathe/core";
import type { GateSpec } from "./schema.js";

export interface GateResult {
  output: string;
}

/**
 * A pass-through node: whatever value flows in flows straight out unchanged. Its only real job is
 * the side effect — writing ambient LLM settings that every node downstream (in this activation's
 * branch of execution) picks up in place of its own local config, per the "a gate overrides"
 * design (see CLAUDE.md).
 */
export async function runGate(ctx: RuntimeHost, spec: GateSpec, inputs: Record<string, string>): Promise<GateResult> {
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  const patch: LlmConfig = {};
  if (spec.temperature !== undefined) patch.temperature = spec.temperature;
  if (spec.topK !== undefined) patch.topK = spec.topK;
  if (spec.compactionMethod !== undefined) patch.compactionMethod = spec.compactionMethod;
  if (spec.compactionThreshold !== undefined) patch.compactionThreshold = spec.compactionThreshold;
  if (Object.keys(patch).length > 0) {
    ctx.llmConfig.set(patch);
    ctx.emit({ kind: "llm_config_set", nodeId: spec.id, patch: { ...patch } });
  }

  const output = inputs["input"] ?? "";
  ctx.emit({ kind: "node_finished", nodeId: spec.id, output, renderedPrompt: "", finishReason: "stop", latencyMs: 0 });
  return { output };
}
