import type { ProviderAdapter, ProviderCallRequest, ProviderCallResult } from "@flowlathe/core";
import { ProviderCallError } from "./errors.js";
import { retryAfterMsFromHeader } from "./retry-after.js";

interface OpenAiChunk {
  choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** A hard backstop against a runaway or malicious server never sending finish_reason/[DONE] —
 *  not a context-budget limit (that's the Gate node's job), just "this must eventually stop." */
const MAX_CONTENT_CHARS = 1_000_000;

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
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        // Not a standard OpenAI param, but widely accepted by local OpenAI-compat servers
        // (llama.cpp, vLLM) — harmless if the specific backend ignores it.
        ...(req.topK !== undefined ? { top_k: req.topK } : {}),
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
        // A malformed chunk from a local server is skipped, not fatal — the stream as a whole
        // may still finish correctly. This deliberately does NOT throw ProviderCallError, unlike
        // the content-length ceiling below: dropping one bad chunk's tokens is lower-hazard than
        // aborting an otherwise-good response, whereas an unbounded accumulator is a real backstop
        // this codebase's "nothing unbounded reaches a prompt" convention requires (see
        // PLAN-SANITIZATION-BOUNDARY.md's layer-2 cap for the same reasoning applied elsewhere).
        let chunk: OpenAiChunk;
        try {
          chunk = JSON.parse(payload) as OpenAiChunk;
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) {
          content += choice.delta.content;
          req.onToken?.(choice.delta.content);
          if (content.length > MAX_CONTENT_CHARS) {
            throw new ProviderCallError(`openai-compat response exceeded ${MAX_CONTENT_CHARS} accumulated characters`);
          }
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
