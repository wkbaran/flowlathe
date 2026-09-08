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
    // The bucket starts full at capacity — one more token must block rather than being granted
    // for free, or this whole test would pass even with an unlimited (non-gating) bucket.
    let resolved = false;
    void bucket.consume(1).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
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

  it("refills proportionally to elapsed time, not by resetting to full capacity on any advance", async () => {
    const clock = new VirtualClock();
    const bucket = new TokenBucket({ ratePerMinute: 600, clock }); // 10 tokens/sec
    await bucket.consume(600); // drain to empty

    clock.advance(300); // should refill exactly 3 tokens, nowhere near full capacity (600)

    // A bucket that (incorrectly) reset to full on any elapsed time would grant this immediately;
    // the real, proportional refill only has 3 tokens, so requesting 4 must block.
    let resolved = false;
    const promise = bucket.consume(4).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    clock.advance(100); // +1 more token = 4 total, exactly enough
    await promise;
    expect(resolved).toBe(true);
  });
});
