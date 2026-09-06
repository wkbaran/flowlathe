import type { RuntimeHost } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { runRouter } from "./run.js";

function fakeCtx(): RuntimeHost {
  return {
    scheduler: { submit: async () => ({ content: "", finishReason: "stop" }) },
    blobs: { put: () => "", get: () => undefined },
    emit: () => undefined,
    clock: { now: () => 0 },
    suspend: () => new Promise(() => undefined),
    resolveSuspended: () => undefined,
    state: { read: () => undefined, write: () => undefined },
  };
}

describe("runRouter", () => {
  it("picks the matching case's route and echoes the input", async () => {
    const result = await runRouter(
      fakeCtx(),
      { id: "r", routes: ["code", "prose"], cases: [{ value: "code", route: "code" }] },
      { input: "code" },
    );
    expect(result).toEqual({ route: "code", passthrough: "code" });
  });

  it("falls back to defaultRoute when nothing matches", async () => {
    const result = await runRouter(
      fakeCtx(),
      { id: "r", routes: ["a", "fallback"], cases: [{ value: "x", route: "a" }], defaultRoute: "fallback" },
      { input: "y" },
    );
    expect(result.route).toBe("fallback");
  });

  it("throws when nothing matches and there is no defaultRoute", async () => {
    await expect(
      runRouter(fakeCtx(), { id: "r", routes: ["a"], cases: [{ value: "x", route: "a" }] }, { input: "y" }),
    ).rejects.toThrow(/no matching case/);
  });
});
