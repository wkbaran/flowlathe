import type { SchedulerClock } from "./scheduler-clock.js";

export interface TokenBucketOptions {
  /** Steady-state rate, in tokens per minute. Also doubles as the burst capacity. */
  ratePerMinute: number;
  clock: SchedulerClock;
}

/** A token bucket gate for rpm/tpm limits; waits (via the injected clock) rather than rejecting. */
export class TokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly clock: SchedulerClock;
  private tokens: number;
  private lastRefillAt: number;

  constructor(opts: TokenBucketOptions) {
    this.capacity = opts.ratePerMinute;
    this.refillPerMs = opts.ratePerMinute / 60_000;
    this.clock = opts.clock;
    this.tokens = this.capacity;
    this.lastRefillAt = opts.clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillAt = now;
  }

  async consume(n = 1): Promise<void> {
    this.refill();
    if (this.tokens >= n) {
      this.tokens -= n;
      return;
    }
    const deficit = n - this.tokens;
    const waitMs = Math.ceil(deficit / this.refillPerMs);
    await new Promise<void>((resolve) => this.clock.setTimer(resolve, waitMs));
    return this.consume(n);
  }
}
