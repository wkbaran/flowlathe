import type { ProviderAdapter, ProviderCallRequest, ProviderCallResult } from "@flowlathe/core";
import { ProviderCallError } from "./errors.js";
import { retryAfterMsFromHeader } from "./retry-after.js";

interface OllamaGenerateChunk {
  response?: string;
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
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
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: req.modelId, prompt: req.prompt, stream: true }),
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
}
