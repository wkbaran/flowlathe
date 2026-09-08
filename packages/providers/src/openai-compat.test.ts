import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiCompatAdapter } from "./openai-compat.js";

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAiCompatAdapter", () => {
  it("accumulates streamed content and reports usage + finish reason", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer sk-test");
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1", apiKey: "sk-test" });
    const tokens: string[] = [];
    const result = await adapter.call({
      providerId: "p",
      modelId: "local-model",
      nodeId: "n1",
      prompt: "hi",
      onToken: (t) => tokens.push(t),
    });

    expect(result).toEqual({ content: "Hello", finishReason: "stop", promptTokens: 3, completionTokens: 2 });
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:1234/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("skips an unparseable data line instead of throwing a bare SyntaxError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
          "data: {not valid json\n\n",
          'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n',
          "data: [DONE]\n\n",
        ]),
      ),
    );
    const adapter = new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1" });
    const result = await adapter.call({ providerId: "p", modelId: "m", nodeId: "n1", prompt: "hi" });
    expect(result.content).toBe("Hello");
    expect(result.finishReason).toBe("stop");
  });

  it("throws a ProviderCallError once accumulated content exceeds the length ceiling", async () => {
    const bigChunk = "x".repeat(400_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseResponse(
          Array.from(
            { length: 4 },
            () => `data: ${JSON.stringify({ choices: [{ delta: { content: bigChunk } }] })}\n\n`,
          ),
        ),
      ),
    );
    const adapter = new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1" });
    await expect(
      adapter.call({ providerId: "p", modelId: "m", nodeId: "n1", prompt: "hi" }),
    ).rejects.toThrow(/exceeded/);
  });

  it("throws with the response body on a non-ok status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request", { status: 400 })),
    );
    const adapter = new OpenAiCompatAdapter({ baseUrl: "http://127.0.0.1:1234/v1" });
    await expect(
      adapter.call({ providerId: "p", modelId: "m", nodeId: "n1", prompt: "hi" }),
    ).rejects.toThrow(/400/);
  });
});
