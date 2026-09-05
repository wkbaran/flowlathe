import { describe, expect, it } from "vitest";
import { VirtualClock } from "./scheduler-clock.js";
import { TokenBucket } from "./token-bucket.js";

describe("TokenBucket", () => {
  it("allows consuming up to capacity immediately", async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket({ ratePerMinute: 60, clock });
    for (let i = 0; i < 60; i++) {
      await bucket.consume(1);
    }
  });

  it("blocks until the clock advances enough to refill", async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket({ ratePerMinute: 60, clock }); // 1 token/sec
    for (let i = 0; i < 60; i++) await bucket.consume(1);

    let resolved = false;
    const promise = bucket.consume(1).then(() => {
      resolved = true;
    });

    clock.advance(500);
    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advance(600);
    await promise;
    expect(resolved).toBe(true);
  });

  it("refills proportionally to elapsed time, not just unblocking on any advance", async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket({ ratePerMinute: 600, clock }); // 10 tokens/sec
    await bucket.consume(600);

    clock.advance(1000); // +10 tokens
    await bucket.consume(10); // exactly enough, should not block
  });
});
