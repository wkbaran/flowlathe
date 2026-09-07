import { describe, expect, it } from "vitest";
import { allOrCancel, createRunControl, isCancellation, nodeFailureEvent, RunCancelled } from "./cancellation.js";

describe("allOrCancel", () => {
  it("resolves with every value, in order, when nothing rejects", async () => {
    const control = createRunControl();
    const result = await allOrCancel(control, [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)]);
    expect(result).toEqual([1, 2, 3]);
    expect(control.signal.aborted).toBe(false);
  });

  it("cancels the run on the first rejection but still awaits every promise", async () => {
    const control = createRunControl();
    let secondSettled = false;
    const second = new Promise<number>((resolve) => {
      setTimeout(() => {
        secondSettled = true;
        resolve(2);
      }, 10);
    });
    const first = Promise.reject(new Error("boom"));

    const promise = allOrCancel(control, [first, second]);
    // The rejection should cancel synchronously (well before the 10ms timer), independent of
    // whether the drain has finished awaiting every sibling yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(control.signal.aborted).toBe(true);

    await expect(promise).rejects.toThrow("boom");
    expect(secondSettled).toBe(true);
  });

  it("throws the lowest-index rejection when two promises fail, not whichever settles first", async () => {
    const control = createRunControl();
    const slowFailure = new Promise<number>((_, reject) => setTimeout(() => reject(new Error("slow")), 5));
    const fastFailure = Promise.reject(new Error("fast"));
    await expect(allOrCancel(control, [slowFailure, fastFailure])).rejects.toThrow("slow");
  });
});

describe("nodeFailureEvent", () => {
  it("maps a RunCancelled error to node_cancelled", () => {
    const event = nodeFailureEvent("n1", new RunCancelled(new Error("sibling failed")));
    expect(event).toEqual({ kind: "node_cancelled", nodeId: "n1", reason: "run cancelled" });
  });

  it("maps a bare AbortError to node_cancelled", () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    const event = nodeFailureEvent("n1", abortError);
    expect(event.kind).toBe("node_cancelled");
  });

  it("maps any other error to node_failed", () => {
    const event = nodeFailureEvent("n1", new Error("oops"));
    expect(event).toEqual({ kind: "node_failed", nodeId: "n1", error: "oops" });
  });
});

describe("isCancellation", () => {
  it("is true for RunCancelled and AbortError, false otherwise", () => {
    expect(isCancellation(new RunCancelled("x"))).toBe(true);
    expect(isCancellation(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(isCancellation(new Error("plain"))).toBe(false);
    expect(isCancellation("not an error")).toBe(false);
  });
});

describe("createRunControl", () => {
  it("cancel is idempotent — a second call does not replace the first reason", () => {
    const control = createRunControl();
    control.cancel(new Error("first"));
    control.cancel(new Error("second"));
    expect(control.signal.aborted).toBe(true);
    const reason = control.signal.reason as RunCancelled;
    expect(reason).toBeInstanceOf(RunCancelled);
    expect((reason.cause as Error).message).toBe("first");
  });

  it("wraps a raw (non-RunCancelled) reason so a cancelled sibling doesn't report the failing node's own error as its own", () => {
    const control = createRunControl();
    const original = new Error("node x blew up");
    control.cancel(original);
    const reason = control.signal.reason;
    expect(reason).toBeInstanceOf(RunCancelled);
    expect((reason as RunCancelled).cause).toBe(original);
    expect((reason as Error).message).not.toBe("node x blew up");
  });
});
