import { createRunControl } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { LoopLimitExceeded, loopUntil, mapConcurrent } from "./combinators.js";

describe("mapConcurrent", () => {
  it("returns results in input order regardless of completion order", async () => {
    const order = [30, 10, 20];
    const results = await mapConcurrent(order, { concurrency: 3, control: createRunControl() }, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return `${i}:${ms}`;
    });
    expect(results).toEqual(["0:30", "1:10", "2:20"]);
  });

  it("never runs more than `concurrency` bodies at once", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapConcurrent([1, 2, 3, 4, 5, 6], { concurrency: 2, control: createRunControl() }, async (item) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return item;
    });
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("stops pulling new items once cancelled, rather than draining the whole list", async () => {
    const control = createRunControl();
    let started = 0;
    await expect(
      mapConcurrent([1, 2, 3, 4, 5, 6, 7, 8], { concurrency: 2, control }, async (item) => {
        started++;
        if (item === 1) throw new Error("boom");
        await new Promise((r) => setTimeout(r, 20));
        return item;
      }),
    ).rejects.toThrow("boom");
    const startedAtFailure = started;
    await new Promise((r) => setTimeout(r, 50));
    // No worker should have pulled a fresh item after the failure cancelled the run — at most
    // the two concurrent workers' current items were already in flight when it happened.
    expect(started).toBe(startedAtFailure);
    expect(started).toBeLessThan(8);
  });
});

describe("loopUntil", () => {
  it("stops as soon as the body returns the stop value", async () => {
    let calls = 0;
    const result = await loopUntil(
      "0",
      { maxIterations: 10, stopValue: "3", control: createRunControl() },
      async (acc) => {
        calls++;
        return String(Number(acc) + 1);
      },
    );
    expect(result).toBe("3");
    expect(calls).toBe(3);
  });

  it("throws LoopLimitExceeded if it never reaches the stop value", async () => {
    await expect(
      loopUntil("0", { maxIterations: 3, stopValue: "never", control: createRunControl() }, async (acc) => acc),
    ).rejects.toThrow(LoopLimitExceeded);
  });
});
