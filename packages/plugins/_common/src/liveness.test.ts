import { describe, expect, it, vi } from "vitest";
import { CachedLivenessProbe } from "./liveness.js";

describe("CachedLivenessProbe", () => {
  it("optimistically reports reachable before the first probe resolves", () => {
    const probe = new CachedLivenessProbe(() => new Promise<boolean>(() => undefined));
    expect(probe.isReachable()).toBe(true);
  });

  it("reflects the probe result once it resolves", async () => {
    const probe = new CachedLivenessProbe(async () => false);
    await new Promise((r) => setTimeout(r, 0));
    expect(probe.isReachable()).toBe(false);
  });

  it("does not re-probe within the TTL", async () => {
    let calls = 0;
    const probe = new CachedLivenessProbe(async () => {
      calls++;
      return true;
    }, 60_000);
    await new Promise((r) => setTimeout(r, 0));
    probe.isReachable();
    probe.isReachable();
    expect(calls).toBe(1);
  });

  it("re-probes after the TTL elapses", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const probe = new CachedLivenessProbe(async () => {
      calls++;
      return true;
    }, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1001);
    probe.isReachable();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    vi.useRealTimers();
  });
});
