import type { ProviderAdapter } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { SimpleScheduler } from "./scheduler.js";

function trackingAdapter(delayMs: number, log: string[]): ProviderAdapter {
  return {
    kind: "test",
    async call(req) {
      log.push(`start:${req.nodeId}`);
      await new Promise((r) => setTimeout(r, delayMs));
      log.push(`end:${req.nodeId}`);
      return { content: "ok", finishReason: "stop" };
    },
  };
}

describe("SimpleScheduler", () => {
  it("limits concurrency to a provider's maxParallel", async () => {
    const log: string[] = [];
    const scheduler = new SimpleScheduler({
      p: { adapter: trackingAdapter(20, log), maxParallel: 1 },
    });
    await Promise.all([
      scheduler.submit({ providerId: "p", modelId: "m", nodeId: "a", prompt: "x" }),
      scheduler.submit({ providerId: "p", modelId: "m", nodeId: "b", prompt: "x" }),
    ]);
    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  });

  it("throws for an unregistered provider id", async () => {
    const scheduler = new SimpleScheduler({});
    await expect(scheduler.submit({ providerId: "nope", modelId: "m", nodeId: "a", prompt: "x" })).rejects.toThrow(
      /unknown provider/,
    );
  });

  it("never reaches the adapter for a call queued behind a full semaphore once it's aborted", async () => {
    const log: string[] = [];
    const scheduler = new SimpleScheduler({
      p: { adapter: trackingAdapter(50, log), maxParallel: 1 },
    });
    const controller = new AbortController();
    const first = scheduler.submit({ providerId: "p", modelId: "m", nodeId: "a", prompt: "x" });
    // "b" queues behind "a" (maxParallel: 1) — abort it while it's still waiting on the semaphore.
    const second = scheduler.submit({ providerId: "p", modelId: "m", nodeId: "b", prompt: "x", signal: controller.signal });
    controller.abort(new Error("cancelled"));

    await expect(second).rejects.toThrow(/cancelled/);
    await first;
    expect(log).toEqual(["start:a", "end:a"]);
  });

  it("throws immediately for an already-aborted signal, without acquiring the semaphore", async () => {
    const log: string[] = [];
    const scheduler = new SimpleScheduler({ p: { adapter: trackingAdapter(5, log), maxParallel: 1 } });
    const controller = new AbortController();
    controller.abort(new Error("pre-aborted"));
    await expect(
      scheduler.submit({ providerId: "p", modelId: "m", nodeId: "a", prompt: "x", signal: controller.signal }),
    ).rejects.toThrow(/pre-aborted/);
    expect(log).toEqual([]);
  });
});
