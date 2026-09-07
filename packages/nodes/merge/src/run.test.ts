import type { RuntimeHost } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { runMerge } from "./run.js";

function fakeCtx(): RuntimeHost {
  return {
    scheduler: { submit: async () => ({ content: "", finishReason: "stop" }) },
    blobs: { put: () => "", get: () => undefined },
    emit: () => undefined,
    clock: { now: () => 0 },
    suspend: () => new Promise(() => undefined),
    resolveSuspended: () => undefined,
    state: { read: () => undefined, write: () => undefined },
    llmConfig: { get: () => ({}), set: () => undefined },
    context: { get: () => [], append: () => undefined, replace: () => undefined },
    tools: { specsFor: () => [], invoke: async () => "", missingToolsets: () => [] },
    net: { fetch: (() => { throw new Error("net not stubbed in this test"); }) as unknown as typeof fetch },
  };
}

describe("runMerge", () => {
  it("prefers in1 when both are present", async () => {
    const result = await runMerge(fakeCtx(), { id: "m" }, { in1: "a", in2: "b" });
    expect(result.output).toBe("a");
  });

  it("falls back to in2 when in1 is absent", async () => {
    const result = await runMerge(fakeCtx(), { id: "m" }, { in2: "b" });
    expect(result.output).toBe("b");
  });

  it("throws if dispatched with neither input present", async () => {
    await expect(runMerge(fakeCtx(), { id: "m" }, {})).rejects.toThrow(/no input value/);
  });
});
