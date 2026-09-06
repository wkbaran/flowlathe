import {
  parseContextValue,
  renderContextText,
  renderTemplate,
  serializeContextValue,
  type ContextMessage,
  type RuntimeHost,
} from "@flowlathe/core";
import type { ContextTransformSpec } from "./schema.js";

export interface ContextTransformResult {
  /** Flat text rendering of the resulting context — for a plain-string consumer like a
   *  PromptNode's `{{ctx}}` template variable. */
  output: string;
  /** The resulting context, serialized as JSON — for chaining into another ContextTransform. */
  context: string;
}

export async function runContextTransform(
  ctx: RuntimeHost,
  spec: ContextTransformSpec,
  inputs: Record<string, string>,
): Promise<ContextTransformResult> {
  ctx.emit({ kind: "node_started", nodeId: spec.id });
  try {
    const source = spec.startsNewContext ? [] : parseContextValue(inputs["context"]);
    let result: ContextMessage[];
    let providerId: string | undefined;
    let modelId: string | undefined;

    switch (spec.transformKind) {
      case "append": {
        const content = renderTemplate(spec.appendTemplate ?? "", inputs);
        result = [...source, { role: spec.appendRole ?? "user", content }];
        break;
      }
      case "drop-before": {
        result = source.slice(spec.keepFromIndex ?? 0);
        break;
      }
      case "filter-role": {
        const exclude = new Set(spec.excludeRoles ?? []);
        result = source.filter((m) => !exclude.has(m.role));
        break;
      }
      case "summarize": {
        if (!spec.providerId || !spec.modelId) {
          throw new Error(`context transform "${spec.id}": "summarize" requires a provider and model`);
        }
        const cut = Math.min(spec.summarizeBeforeIndex ?? source.length, source.length);
        const toSummarize = source.slice(0, cut);
        const rest = source.slice(cut);
        const prompt = renderTemplate(spec.summarizeTemplate ?? "Summarize the conversation so far:\n{{transcript}}", {
          ...inputs,
          transcript: renderContextText(toSummarize),
        });
        providerId = spec.providerId;
        modelId = spec.modelId;
        const callResult = await ctx.scheduler.submit({
          providerId,
          modelId,
          nodeId: spec.id,
          prompt,
          onToken: (token) => ctx.emit({ kind: "token", nodeId: spec.id, token }),
        });
        result = [{ role: "system", content: callResult.content }, ...rest];
        break;
      }
    }

    const output = renderContextText(result);
    ctx.emit({
      kind: "node_finished",
      nodeId: spec.id,
      output,
      renderedPrompt: "",
      finishReason: "stop",
      latencyMs: 0,
    });
    ctx.emit({
      kind: "context_transform",
      nodeId: spec.id,
      transformKind: spec.transformKind,
      sourceMessages: source,
      resultMessages: result,
      providerId,
      modelId,
    });
    return { output, context: serializeContextValue(result) };
  } catch (err) {
    ctx.emit({ kind: "node_failed", nodeId: spec.id, error: (err as Error).message });
    throw err;
  }
}
