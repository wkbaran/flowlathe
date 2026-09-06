import type { ContextMessage, LlmConfig, RunEvent, RuntimeHost } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { runPrompt } from "./run.js";

function fakeCtx(overrides: Partial<RuntimeHost> = {}): { ctx: RuntimeHost; events: RunEvent[] } {
  const events: RunEvent[] = [];
  const values = new Map<string, unknown>();
  let llmConfig: LlmConfig = {};
  const contexts = new Map<string, ContextMessage[]>();
  const ctx: RuntimeHost = {
    scheduler: {
      submit: async (req) => ({
        content: `echo: ${req.prompt}`,
        finishReason: "stop",
        promptTokens: 1,
        completionTokens: 1,
      }),
    },
    blobs: { put: () => "", get: () => undefined },
    emit: (event) => events.push(event),
    clock: { now: () => 0 },
    suspend: () => new Promise(() => undefined),
    resolveSuspended: () => undefined,
    state: {
      read: (entry) => values.get(entry),
      write: (entry, value) => values.set(entry, value),
    },
    llmConfig: {
      get: () => llmConfig,
      set: (patch) => {
        llmConfig = { ...llmConfig, ...patch };
      },
    },
    context: {
      get: (nodeId) => contexts.get(nodeId) ?? [],
      append: (nodeId, turns) => contexts.set(nodeId, [...(contexts.get(nodeId) ?? []), ...turns]),
      replace: (nodeId, messages) => contexts.set(nodeId, messages),
    },
    ...overrides,
  };
  return { ctx, events };
}

describe("runPrompt", () => {
  it("renders the template and returns the provider's output", async () => {
    const { ctx } = fakeCtx();
    const result = await runPrompt(
      ctx,
      { id: "a", template: "hi {{name}}", providerId: "mock", modelId: "m", enableStateTools: false },
      { name: "world" },
    );
    expect(result.renderedPrompt).toBe("hi world");
    expect(result.output).toBe("echo: hi world");
  });

  it("emits node_started, context_appended, then node_finished in order", async () => {
    const { ctx, events } = fakeCtx();
    await runPrompt(ctx, { id: "a", template: "hi", providerId: "mock", modelId: "m", enableStateTools: false }, {});
    expect(events.map((e) => e.kind)).toEqual(["node_started", "context_appended", "node_finished"]);
  });

  it("emits node_failed and rethrows when the provider call fails", async () => {
    const { ctx, events } = fakeCtx({
      scheduler: {
        submit: async () => {
          throw new Error("boom");
        },
      },
    });
    await expect(
      runPrompt(ctx, { id: "a", template: "hi", providerId: "mock", modelId: "m", enableStateTools: false }, {}),
    ).rejects.toThrow("boom");
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_failed"]);
  });

  it("executes a read_state/write_state tool call and continues to a final answer", async () => {
    const calls: string[] = [];
    const { ctx } = fakeCtx({
      state: {
        read: (entry) => {
          calls.push(`read:${entry}`);
          return "prior-value";
        },
        write: (entry, value) => {
          calls.push(`write:${entry}=${JSON.stringify(value)}`);
        },
      },
    });
    ctx.scheduler.submit = async (req) => {
      if (!req.prompt.includes("[tool calls]")) {
        return {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [{ id: "call_1", name: "write_state", args: { entry: "notes", value: "hello" } }],
        };
      }
      return { content: "done", finishReason: "stop" };
    };
    const result = await runPrompt(
      ctx,
      { id: "a", template: "hi", providerId: "mock", modelId: "m", enableStateTools: true },
      {},
    );
    expect(calls).toEqual(['write:notes="hello"']);
    expect(result.output).toBe("done");
  });

  it("accumulates its own conversation across repeated calls (e.g. a Loop body)", async () => {
    const { ctx } = fakeCtx();
    const spec = { id: "a", template: "turn {{n}}", providerId: "mock", modelId: "m", enableStateTools: false };
    const first = await runPrompt(ctx, spec, { n: "1" });
    expect(first.renderedPrompt).toBe("turn 1"); // nothing accumulated yet on the first call

    const second = await runPrompt(ctx, spec, { n: "2" });
    expect(second.renderedPrompt).toBe("user: turn 1\nassistant: echo: turn 1\nuser: turn 2");
  });

  it("a gate's ambient temperature/topK reach the provider call, overriding the node's own", async () => {
    let seen: { temperature?: number | undefined; topK?: number | undefined } = {};
    const { ctx } = fakeCtx();
    ctx.scheduler.submit = async (req) => {
      seen = { temperature: req.temperature, topK: req.topK };
      return { content: "ok", finishReason: "stop" };
    };
    ctx.llmConfig.set({ temperature: 0.9 });
    await runPrompt(
      ctx,
      { id: "a", template: "hi", providerId: "mock", modelId: "m", enableStateTools: false, temperature: 0.1, topK: 10 },
      {},
    );
    expect(seen).toEqual({ temperature: 0.9, topK: 10 });
  });

  it("compacts via drop-oldest-half once the ambient threshold is crossed", async () => {
    const { ctx, events } = fakeCtx();
    const spec = { id: "a", template: "{{n}}", providerId: "mock", modelId: "m", enableStateTools: false };
    ctx.context.append("a", [
      { role: "system", content: "keep me" },
      { role: "user", content: "x".repeat(400) },
      { role: "assistant", content: "y".repeat(400) },
    ]);
    ctx.llmConfig.set({ compactionMethod: "drop-oldest-half", compactionThreshold: { kind: "fixed", tokens: 10 } });

    await runPrompt(ctx, spec, { n: "go" });

    expect(events.map((e) => e.kind)).toContain("context_compacted");
    const remaining = ctx.context.get("a");
    expect(remaining.some((m) => m.content === "keep me")).toBe(true);
    expect(remaining.some((m) => m.content.startsWith("x"))).toBe(false);
  });
});
