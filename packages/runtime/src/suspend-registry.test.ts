import { createRunControl } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { createSuspendRegistry } from "./suspend-registry.js";

describe("createSuspendRegistry", () => {
  it("resolves a pending suspend with the value passed to resolveSuspended", async () => {
    const registry = createSuspendRegistry(createRunControl());
    const promise = registry.suspend("k", { type: "pause", message: "hold" });
    registry.resolveSuspended("k", "answer");
    await expect(promise).resolves.toBe("answer");
  });

  it("rejects a pending suspend when the control is cancelled", async () => {
    const control = createRunControl();
    const registry = createSuspendRegistry(control);
    const promise = registry.suspend("k", { type: "pause", message: "hold" });
    const reason = new Error("sibling failed");
    control.cancel(reason);
    await expect(promise).rejects.toBe(control.signal.reason);
  });

  it("rejects immediately if the control is already aborted before suspend is called", async () => {
    const control = createRunControl();
    control.cancel(new Error("already gone"));
    const registry = createSuspendRegistry(control);
    await expect(registry.suspend("k", { type: "pause", message: "hold" })).rejects.toBe(control.signal.reason);
  });

  it("resolving normally removes its abort listener (a later cancel doesn't touch it again)", async () => {
    const control = createRunControl();
    const registry = createSuspendRegistry(control);
    const promise = registry.suspend("k", { type: "pause", message: "hold" });
    registry.resolveSuspended("k", "answer");
    await expect(promise).resolves.toBe("answer");
    // No throw/unhandled-rejection from a listener firing again on an already-settled promise.
    expect(() => control.cancel(new Error("later failure"))).not.toThrow();
  });

  it("throws resolving a key with no pending suspend", () => {
    const registry = createSuspendRegistry(createRunControl());
    expect(() => registry.resolveSuspended("missing", "x")).toThrow(/no suspended activation/);
  });
});
