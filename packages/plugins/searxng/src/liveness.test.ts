import { describe, expect, it, vi } from "vitest";
import { CachedLivenessProbe } from "./liveness.js";

describe("CachedLivenessProbe", () => {
  it("optimistically reports reachable before the first probe resolves", () => {
    const client = { isReachable: () => new Promise<boolean>(() => undefined) };
    const probe = new CachedLivenessProbe(client as never);
    expect(probe.isReachable()).toBe(true);
  });

  it("reflects the probe result once it resolves", async () => {
    const client = { isReachable: async () => false };
    const probe = new CachedLivenessProbe(client as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(probe.isReachable()).toBe(false);
  });

  it("does not re-probe within the TTL", async () => {
    let calls = 0;
    const client = {
      isReachable: async () => {
        calls++;
        return true;
      },
    };
    const probe = new CachedLivenessProbe(client as never, 60_000);
    await new Promise((r) => setTimeout(r, 0));
    probe.isReachable();
    probe.isReachable();
    expect(calls).toBe(1);
  });

  it("re-probes after the TTL elapses", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = {
      isReachable: async () => {
        calls++;
        return true;
      },
    };
    const probe = new CachedLivenessProbe(client as never, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1001);
    probe.isReachable();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    vi.useRealTimers();
  });
});
