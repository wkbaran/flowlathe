import type { RunEvent, RuntimeHost } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { runTrigger } from "./run.js";

function fakeCtx(): { ctx: RuntimeHost; events: RunEvent[] } {
  const events: RunEvent[] = [];
  const ctx: RuntimeHost = {
    scheduler: { submit: async () => ({ content: "", finishReason: "stop" }) },
    blobs: { put: () => "", get: () => undefined },
    emit: (event) => events.push(event),
    clock: { now: () => 0 },
    suspend: () => new Promise(() => undefined),
    resolveSuspended: () => undefined,
    state: { read: () => undefined, write: () => undefined },
    llmConfig: { get: () => ({}), set: () => undefined },
    context: { get: () => [], append: () => undefined, replace: () => undefined },
    tools: { specsFor: () => [], invoke: async () => "", missingToolsets: () => [] },
    net: { fetch: (() => { throw new Error("net not stubbed in this test"); }) as unknown as typeof fetch },
  };
  return { ctx, events };
}

describe("runTrigger", () => {
  it("resolves to testPayload with empty author/channel/message ids", async () => {
    const { ctx } = fakeCtx();
    const result = await runTrigger(ctx, { id: "t", source: "manual", testPayload: "hello from the desk" });
    expect(result).toEqual({ content: "hello from the desk", authorId: "", channelId: "", messageId: "" });
  });

  it("defaults testPayload to an empty string", async () => {
    const { ctx } = fakeCtx();
    const result = await runTrigger(ctx, { id: "t", source: "discord", testPayload: "" });
    expect(result.content).toBe("");
  });

  it("emits node_started then node_finished", async () => {
    const { ctx, events } = fakeCtx();
    await runTrigger(ctx, { id: "t", source: "manual", testPayload: "x" });
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_finished"]);
  });
});
