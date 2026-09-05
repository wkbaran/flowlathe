import type { RuntimeHost, RunEvent } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { runPrompt } from "./run.js";

function fakeCtx(overrides: Partial<RuntimeHost> = {}): { ctx: RuntimeHost; events: RunEvent[] } {
  const events: RunEvent[] = [];
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
    ...overrides,
  };
  return { ctx, events };
}

describe("runPrompt", () => {
  it("renders the template and returns the provider's output", async () => {
    const { ctx } = fakeCtx();
    const result = await runPrompt(ctx, { id: "a", template: "hi {{name}}", providerId: "mock", modelId: "m" }, {
      name: "world",
    });
    expect(result.renderedPrompt).toBe("hi world");
    expect(result.output).toBe("echo: hi world");
  });

  it("emits node_started, token(s)?, and node_finished in order", async () => {
    const { ctx, events } = fakeCtx();
    await runPrompt(ctx, { id: "a", template: "hi", providerId: "mock", modelId: "m" }, {});
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
      runPrompt(ctx, { id: "a", template: "hi", providerId: "mock", modelId: "m" }, {}),
    ).rejects.toThrow("boom");
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_failed"]);
  });
});
