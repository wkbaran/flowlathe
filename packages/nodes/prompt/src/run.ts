import { READ_STATE_TOOL, WRITE_STATE_TOOL, renderTemplate, type PromptResult, type RuntimeHost } from "@flowlathe/core";
import type { PromptSpec } from "./schema.js";

const MAX_TOOL_ROUNDS = 4;

export async function runPrompt(
  ctx: RuntimeHost,
  spec: PromptSpec,
  inputs: Record<string, string>,
): Promise<PromptResult> {
  const renderedPrompt = renderTemplate(spec.template, inputs);
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  const start = ctx.clock.now();
  try {
    const tools = spec.enableStateTools ? [READ_STATE_TOOL, WRITE_STATE_TOOL] : undefined;
    let prompt = renderedPrompt;
    let result;
    for (let round = 0; ; round++) {
      result = await ctx.scheduler.submit({
        providerId: spec.providerId,
        modelId: spec.modelId,
        nodeId: spec.id,
        prompt,
        tools,
        onToken: (token) => ctx.emit({ kind: "token", nodeId: spec.id, token }),
      });
      if (!result.toolCalls || result.toolCalls.length === 0) break;
      if (round >= MAX_TOOL_ROUNDS) {
        throw new Error(`prompt "${spec.id}" exceeded ${MAX_TOOL_ROUNDS} tool-call rounds without finishing`);
      }
      const resultLines = result.toolCalls.map((call) => runBuiltinTool(ctx, spec.id, call));
      prompt = `${prompt}\n[tool calls]\n${resultLines.join("\n")}\nContinue.`;
    }
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

function runBuiltinTool(ctx: RuntimeHost, nodeId: string, call: { name: string; args: Record<string, unknown> }): string {
  if (call.name === "read_state") {
    const entry = String(call.args["entry"]);
    const value = ctx.state.read(entry, { viaTool: true, activationKey: nodeId });
    return `[read_state ${entry}]: ${JSON.stringify(value)}`;
  }
  if (call.name === "write_state") {
    const entry = String(call.args["entry"]);
    ctx.state.write(entry, call.args["value"], { viaTool: true, activationKey: nodeId });
    return `[write_state ${entry}]: ok`;
  }
  return `[${call.name}]: error - unknown tool`;
}
