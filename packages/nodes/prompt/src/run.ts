import type { RuntimeHost, PromptResult } from "@flowlathe/core";
import { renderTemplate } from "@flowlathe/core";
import type { PromptSpec } from "./schema.js";

export async function runPrompt(
  ctx: RuntimeHost,
  spec: PromptSpec,
  inputs: Record<string, string>,
): Promise<PromptResult> {
  const renderedPrompt = renderTemplate(spec.template, inputs);
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  const start = ctx.clock.now();
  try {
    const result = await ctx.scheduler.submit({
      providerId: spec.providerId,
      modelId: spec.modelId,
      nodeId: spec.id,
      prompt: renderedPrompt,
      onToken: (token) => ctx.emit({ kind: "token", nodeId: spec.id, token }),
    });
    const latencyMs = ctx.clock.now() - start;
    ctx.emit({
      kind: "node_finished",
      nodeId: spec.id,
      output: result.content,
      renderedPrompt,
      finishReason: result.finishReason,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs,
    });
    return {
      output: result.content,
      renderedPrompt,
      finishReason: result.finishReason,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs,
    };
  } catch (err) {
    ctx.emit({ kind: "node_failed", nodeId: spec.id, error: (err as Error).message });
    throw err;
  }
}
