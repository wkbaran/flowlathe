import type { LlmConfig, RunEvent, RuntimeHost } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { runGate } from "./run.js";

function fakeCtx(): { ctx: RuntimeHost; events: RunEvent[] } {
  const events: RunEvent[] = [];
  let config: LlmConfig = {};
  const ctx: RuntimeHost = {
    scheduler: { submit: async () => ({ content: "", finishReason: "stop" }) },
    blobs: { put: () => "", get: () => undefined },
    emit: (event) => events.push(event),
    clock: { now: () => 0 },
    suspend: () => new Promise(() => undefined),
    resolveSuspended: () => undefined,
    state: { read: () => undefined, write: () => undefined },
    llmConfig: {
      get: () => config,
      set: (patch) => {
        config = { ...config, ...patch };
      },
    },
    context: { get: () => [], append: () => undefined, replace: () => undefined },
    tools: { specsFor: () => [], invoke: async () => "", missingToolsets: () => [] },
  };
  return { ctx, events };
}

describe("runGate", () => {
  it("passes its input straight through unchanged", async () => {
    const { ctx } = fakeCtx();
    const result = await runGate(ctx, { id: "g" }, { input: "hello" });
    expect(result.output).toBe("hello");
  });

  it("writes only the fields it configures into ambient llmConfig", async () => {
    const { ctx } = fakeCtx();
    await runGate(ctx, { id: "g", temperature: 0.2 }, {});
    expect(ctx.llmConfig.get()).toEqual({ temperature: 0.2 });
  });

  it("sets compaction method + threshold together", async () => {
    const { ctx } = fakeCtx();
    await runGate(
      ctx,
      { id: "g", compactionMethod: "drop-oldest-half", compactionThreshold: { kind: "fixed", tokens: 500 } },
      {},
    );
    expect(ctx.llmConfig.get()).toEqual({
      compactionMethod: "drop-oldest-half",
      compactionThreshold: { kind: "fixed", tokens: 500 },
    });
  });

  it("emits node_started, llm_config_set, and node_finished in order", async () => {
    const { ctx, events } = fakeCtx();
    await runGate(ctx, { id: "g", topK: 40 }, {});
    expect(events.map((e) => e.kind)).toEqual(["node_started", "llm_config_set", "node_finished"]);
  });

  it("emits no llm_config_set when nothing is configured", async () => {
    const { ctx, events } = fakeCtx();
    await runGate(ctx, { id: "g" }, {});
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_finished"]);
  });
});
