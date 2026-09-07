import {
  dropOldestHalf,
  estimateTokenCount,
  renderContextText,
  renderTemplate,
  splitOldestHalf,
  thresholdTokens,
  type ContextMessage,
  type PromptResult,
  type RuntimeHost,
} from "@flowlathe/core";
import type { PromptSpec } from "./schema.js";

const MAX_TOOL_ROUNDS = 4;

export async function runPrompt(
  ctx: RuntimeHost,
  spec: PromptSpec,
  inputs: Record<string, string>,
  signal?: AbortSignal,
): Promise<PromptResult> {
  const contextKey = spec.contextNodeId ?? spec.id;
  const renderedPrompt = renderTemplate(spec.template, inputs);
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  const start = ctx.clock.now();
  try {
    const ambient = ctx.llmConfig.get();
    const temperature = ambient.temperature ?? spec.temperature;
    const topK = ambient.topK ?? spec.topK;

    await maybeCompact(ctx, spec, contextKey);

    const priorContext = ctx.context.get(contextKey);
    const finalPrompt = priorContext.length > 0 ? `${renderContextText(priorContext)}\nuser: ${renderedPrompt}` : renderedPrompt;

    const toolsets = [...(spec.enableStateTools ? ["state"] : []), ...spec.enabledToolsets];
    const tools = toolsets.length > 0 ? ctx.tools.specsFor(toolsets) : undefined;
    let prompt = finalPrompt;
    let result;
    for (let round = 0; ; round++) {
      result = await ctx.scheduler.submit({
        providerId: spec.providerId,
        modelId: spec.modelId,
        nodeId: spec.id,
        prompt,
        temperature,
        topK,
        tools,
        onToken: (token) => ctx.emit({ kind: "token", nodeId: spec.id, token }),
      });
      if (!result.toolCalls || result.toolCalls.length === 0) break;
      if (round >= MAX_TOOL_ROUNDS) {
        throw new Error(`prompt "${spec.id}" exceeded ${MAX_TOOL_ROUNDS} tool-call rounds without finishing`);
      }
      const resultLines = await Promise.all(
        result.toolCalls.map((call) => ctx.tools.invoke(call.name, call.args, { activationKey: spec.id, signal })),
      );
      prompt = `${prompt}\n[tool calls]\n${resultLines.join("\n")}\nContinue.`;
    }

    ctx.context.append(contextKey, [
      { role: "user", content: renderedPrompt },
      { role: "assistant", content: result.content },
    ]);
    ctx.emit({ kind: "context_appended", nodeId: spec.id, messageCount: ctx.context.get(contextKey).length });

    const latencyMs = ctx.clock.now() - start;
    ctx.emit({
      kind: "node_finished",
      nodeId: spec.id,
      output: result.content,
      renderedPrompt: finalPrompt,
      finishReason: result.finishReason,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs,
    });
    return {
      output: result.content,
      renderedPrompt: finalPrompt,
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

/** Runs before this call is built: if a Gate has set a compaction method + threshold and this
 *  node's own accumulated context (see PLAN.md's "State under parallelism" for the analogous
 *  write-log-per-node approach) already crosses it, compacts it first — so the call about to be
 *  built never sees the bloat. Never fires with no Gate in play (no ambient threshold configured). */
async function maybeCompact(ctx: RuntimeHost, spec: PromptSpec, contextKey: string): Promise<void> {
  const { compactionMethod, compactionThreshold } = ctx.llmConfig.get();
  if (!compactionMethod || !compactionThreshold) return;
  const current = ctx.context.get(contextKey);
  if (current.length === 0) return;
  const tokens = estimateTokenCount(renderContextText(current));
  if (tokens < thresholdTokens(compactionThreshold)) return;

  let compacted: ContextMessage[];
  if (compactionMethod === "drop-oldest-half") {
    compacted = dropOldestHalf(current);
  } else {
    const { system, toCompact, rest } = splitOldestHalf(current);
    const summaryPrompt = `Summarize the following conversation excerpt in a few sentences, preserving anything a later turn might need:\n${renderContextText(toCompact)}`;
    const summary = await ctx.scheduler.submit({
      providerId: spec.providerId,
      modelId: spec.modelId,
      nodeId: spec.id,
      prompt: summaryPrompt,
    });
    compacted = [...system, { role: "system", content: summary.content }, ...rest];
  }
  ctx.context.replace(contextKey, compacted);
  ctx.emit({ kind: "context_compacted", nodeId: spec.id, method: compactionMethod, beforeMessages: current, afterMessages: compacted });
}
