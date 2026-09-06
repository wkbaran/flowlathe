import type { RunEvent, RuntimeHost } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { runPrompt } from "./run.js";

function fakeCtx(overrides: Partial<RuntimeHost> = {}): { ctx: RuntimeHost; events: RunEvent[] } {
  const events: RunEvent[] = [];
  const values = new Map<string, unknown>();
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

  it("emits node_started, token(s)?, and node_finished in order", async () => {
    const { ctx, events } = fakeCtx();
    await runPrompt(ctx, { id: "a", template: "hi", providerId: "mock", modelId: "m", enableStateTools: false }, {});
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_finished"]);
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
      scheduler: {
        submit: async (req) => {
          if (!req.prompt.includes("[tool calls]")) {
            return {
              content: "",
              finishReason: "tool_calls",
              toolCalls: [{ id: "call_1", name: "write_state", args: { entry: "notes", value: "hello" } }],
            };
          }
          return { content: "done", finishReason: "stop" };
        },
      },
    });
    const result = await runPrompt(
      ctx,
      { id: "a", template: "hi", providerId: "mock", modelId: "m", enableStateTools: true },
      {},
    );
    expect(calls).toEqual(['write:notes="hello"']);
    expect(result.output).toBe("done");
  });
});
