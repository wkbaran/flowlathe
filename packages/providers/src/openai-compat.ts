import type { ProviderAdapter, ProviderCallRequest, ProviderCallResult } from "@flowlathe/core";
import { ProviderCallError } from "./errors.js";
import { retryAfterMsFromHeader } from "./retry-after.js";

interface OpenAiChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface OpenAiCompatAdapterOptions {
  baseUrl: string;
  apiKey?: string | undefined;
}

/**
 * Talks to any OpenAI-chat-completions-shaped endpoint (LM Studio, llama.cpp's server,
 * vLLM's OpenAI-compat mode) via a single base-URL + optional bearer key.
 */
export class OpenAiCompatAdapter implements ProviderAdapter {
  readonly kind = "openai-compat";
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(opts: OpenAiCompatAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
  }

  async call(req: ProviderCallRequest): Promise<ProviderCallResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: req.modelId,
        messages: [{ role: "user", content: req.prompt }],
        stream: true,
      }),
      signal: req.signal ?? null,
    });
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new ProviderCallError(`openai-compat request failed: ${res.status} ${body}`, {
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
        const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
        if (!payload || payload === "[DONE]") continue;
        const chunk = JSON.parse(payload) as OpenAiChunk;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          content += choice.delta.content;
          req.onToken?.(choice.delta.content);
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens;
          completionTokens = chunk.usage.completion_tokens;
        }
      }
    }

    return { content, finishReason, promptTokens, completionTokens };
  }
}
