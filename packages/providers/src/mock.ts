import { createHash } from "node:crypto";
import type { ProviderAdapter, ProviderCallRequest, ProviderCallResult } from "@flowlathe/core";

export function mockResponseKey(nodeId: string, prompt: string): string {
  const promptSha = createHash("sha256").update(prompt, "utf-8").digest("hex");
  return `${nodeId}::${promptSha}`;
}

export class MissingMockResponse extends Error {
  constructor(key: string) {
    super(`no mock response registered for key "${key}"`);
    this.name = "MissingMockResponse";
  }
}

export interface MockProviderAdapterOptions {
  /** Keyed by `mockResponseKey(nodeId, renderedPrompt)`. Missing keys throw rather than guess. */
  responses?: Map<string, string>;
}

export class MockProviderAdapter implements ProviderAdapter {
  readonly kind = "mock";
  private readonly responses: Map<string, string> | undefined;

  constructor(opts: MockProviderAdapterOptions = {}) {
    this.responses = opts.responses;
  }

  async call(req: ProviderCallRequest): Promise<ProviderCallResult> {
    const content = this.responses
      ? lookup(this.responses, req.nodeId, req.prompt)
      : `[mock:${req.modelId}] ${req.prompt}`;
    req.onToken?.(content);
    return { content, finishReason: "stop" };
  }
}

function lookup(responses: Map<string, string>, nodeId: string, prompt: string): string {
  const key = mockResponseKey(nodeId, prompt);
  const value = responses.get(key);
  if (value === undefined) throw new MissingMockResponse(key);
  return value;
}
