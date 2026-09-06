import type { ProviderAdapter, ProviderCallRequest, ProviderCallResult, ToolCall, ToolSpec } from "@flowlathe/core";
import { ProviderCallError } from "./errors.js";
import { retryAfterMsFromHeader } from "./retry-after.js";

interface OllamaGenerateChunk {
  response?: string;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaChatChunk {
  message?: { content?: string; tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[] };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

function toOllamaTool(tool: ToolSpec): unknown {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } };
}

function toOllamaOptions(req: ProviderCallRequest): Record<string, number> | undefined {
  const options: Record<string, number> = {};
  if (req.temperature !== undefined) options["temperature"] = req.temperature;
  if (req.topK !== undefined) options["top_k"] = req.topK;
  return Object.keys(options).length > 0 ? options : undefined;
}

export interface OllamaProviderAdapterOptions {
  baseUrl: string;
}

export class OllamaProviderAdapter implements ProviderAdapter {
  readonly kind = "ollama";
  private readonly baseUrl: string;

  constructor(opts: OllamaProviderAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
  }

  async call(req: ProviderCallRequest): Promise<ProviderCallResult> {
    if (req.tools && req.tools.length > 0) return this.callChat(req, req.tools);
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: req.modelId, prompt: req.prompt, stream: true, options: toOllamaOptions(req) }),
      signal: req.signal ?? null,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new ProviderCallError(`ollama request failed: ${res.status} ${body}`, {
        status: res.status,
        retryAfterMs: retryAfterMsFromHeader(res.headers.get("retry-after")),
      });
    }

    let content = "";
    let finishReason = "stop";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as OllamaGenerateChunk;
        if (chunk.response) {
          content += chunk.response;
          req.onToken?.(chunk.response);
        }
        if (chunk.done) {
          finishReason = chunk.done_reason ?? "stop";
          promptTokens = chunk.prompt_eval_count;
          completionTokens = chunk.eval_count;
        }
      }
    }

    return { content, finishReason, promptTokens, completionTokens };
  }

  /** Tool-calling requires Ollama's `/api/chat` endpoint (`/api/generate` has no `tools` param). */
  private async callChat(req: ProviderCallRequest, tools: ToolSpec[]): Promise<ProviderCallResult> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: req.modelId,
        messages: [{ role: "user", content: req.prompt }],
        tools: tools.map(toOllamaTool),
        stream: true,
        options: toOllamaOptions(req),
      }),
      signal: req.signal ?? null,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new ProviderCallError(`ollama request failed: ${res.status} ${body}`, {
        status: res.status,
        retryAfterMs: retryAfterMsFromHeader(res.headers.get("retry-after")),
      });
    }

    let content = "";
    let finishReason = "stop";
    let toolCalls: ToolCall[] | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as OllamaChatChunk;
        if (chunk.message?.content) {
          content += chunk.message.content;
          req.onToken?.(chunk.message.content);
        }
        if (chunk.message?.tool_calls && chunk.message.tool_calls.length > 0) {
          toolCalls = chunk.message.tool_calls.map((tc, i) => ({
            id: `call_${i}`,
            name: tc.function.name,
            args: tc.function.arguments,
          }));
        }
        if (chunk.done) {
          finishReason = toolCalls ? "tool_calls" : (chunk.done_reason ?? "stop");
          promptTokens = chunk.prompt_eval_count;
          completionTokens = chunk.eval_count;
        }
      }
    }

    return { content, finishReason, toolCalls, promptTokens, completionTokens };
  }
}
