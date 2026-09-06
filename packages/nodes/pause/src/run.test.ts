import type { RunEvent, RuntimeHost } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { runPause } from "./run.js";

describe("runPause", () => {
  it("suspends, then resumes and passes its input through", async () => {
    const events: RunEvent[] = [];
    let resolvePending: ((v: string) => void) | undefined;
    const ctx: RuntimeHost = {
      scheduler: { submit: async () => ({ content: "", finishReason: "stop" }) },
      blobs: { put: () => "", get: () => undefined },
      emit: (e) => events.push(e),
      clock: { now: () => 0 },
      suspend: (key) =>
        new Promise((resolve) => {
          expect(key).toBe("p");
          resolvePending = resolve;
        }),
      resolveSuspended: () => undefined,
      state: { read: () => undefined, write: () => undefined },
      llmConfig: { get: () => ({}), set: () => undefined },
      context: { get: () => [], append: () => undefined, replace: () => undefined },
      tools: { specsFor: () => [], invoke: async () => "" },
    };

    const promise = runPause(ctx, { id: "p", message: "hold on" }, { input: "carried-value" });
    await new Promise((r) => setImmediate(r));
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_suspended"]);

    resolvePending?.("");
    const result = await promise;
    expect(result.output).toBe("carried-value");
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_suspended", "node_finished"]);
  });
});
