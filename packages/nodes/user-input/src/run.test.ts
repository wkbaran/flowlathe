import type { RunEvent, RuntimeHost } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { runUserInput } from "./run.js";

describe("runUserInput", () => {
  it("suspends with the prompt, then resumes with the human's answer", async () => {
    const events: RunEvent[] = [];
    let resolvePending: ((v: string) => void) | undefined;
    const ctx: RuntimeHost = {
      scheduler: { submit: async () => ({ content: "", finishReason: "stop" }) },
      blobs: { put: () => "", get: () => undefined },
      emit: (e) => events.push(e),
      clock: { now: () => 0 },
      suspend: (_key, reason) =>
        new Promise((resolve) => {
          expect(reason).toEqual({ type: "user_input", prompt: "What's your name?" });
          resolvePending = resolve;
        }),
      resolveSuspended: () => undefined,
      state: { read: () => undefined, write: () => undefined },
      llmConfig: { get: () => ({}), set: () => undefined },
      context: { get: () => [], append: () => undefined, replace: () => undefined },
    };

    const promise = runUserInput(ctx, { id: "u", prompt: "What's your name?" });
    await new Promise((r) => setImmediate(r));
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_suspended"]);

    resolvePending?.("Ada");
    const result = await promise;
    expect(result.output).toBe("Ada");
  });
});
