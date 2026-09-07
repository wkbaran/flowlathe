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
    // Deterministic tool-call simulation: a prompt can ask the mock to "decide" to call a tool
    // by embedding a literal `CALL_TOOL: <name> <jsonArgs>` line. Only honored once per prompt —
    // the caller's follow-up round appends a `[tool calls]` marker, which suppresses it, so the
    // loop terminates instead of re-triggering the same call forever.
    if (req.tools && req.tools.length > 0 && !req.prompt.includes("[tool calls]")) {
      const match = req.prompt.match(/CALL_TOOL:\s*(\w+)\s+(\{.*\})/);
      if (match) {
        const [, name, argsJson] = match;
        return { content: "", finishReason: "tool_calls", toolCalls: [{ id: "call_1", name: name!, args: JSON.parse(argsJson!) }] };
      }
    }

    // `FAIL: <message>` / `DELAY_MS: <n>` are testing conventions alongside `CALL_TOOL:`, added
    // for PLAN-CANCELLATION.md's failing-fan-out fixture: a deterministic way to make one sibling
    // reject quickly while another sits in an interruptible sleep, so the abort half of
    // cancellation (not just the await-drain half) is actually exercised. See CLAUDE.md.
    const failMatch = req.prompt.match(/^FAIL:\s*(.*)$/m);
    if (failMatch) {
      throw new Error(failMatch[1]);
    }
    const delayMatch = req.prompt.match(/^DELAY_MS:\s*(\d+)/m);
    if (delayMatch) {
      await interruptibleSleep(Number(delayMatch[1]), req.signal);
    }

    const content = this.responses
      ? lookup(this.responses, req.nodeId, req.prompt)
      : `[mock:${req.modelId}] ${req.prompt}`;
    req.onToken?.(content);
    return { content, finishReason: "stop" };
  }
}

function interruptibleSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function lookup(responses: Map<string, string>, nodeId: string, prompt: string): string {
  const key = mockResponseKey(nodeId, prompt);
  const value = responses.get(key);
  if (value === undefined) throw new MissingMockResponse(key);
  return value;
}
