export type TimerHandle = symbol;

export interface SchedulerClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

export class RealSchedulerClock implements SchedulerClock {
  now(): number {
    return Date.now();
  }

  setTimer(callback: () => void, delayMs: number): TimerHandle {
    const handle = Symbol();
    const timeout = setTimeout(callback, delayMs);
    timersByHandle.set(handle, timeout);
    return handle;
  }

  clearTimer(handle: TimerHandle): void {
    const timeout = timersByHandle.get(handle);
    if (timeout) clearTimeout(timeout);
    timersByHandle.delete(handle);
  }
}

const timersByHandle = new Map<TimerHandle, ReturnType<typeof setTimeout>>();

interface ScheduledTimer {
  handle: TimerHandle;
  dueAt: number;
  callback: () => void;
}

/**
 * A fully deterministic clock for policy tests: time only moves when `advance()` is called,
 * and due timers fire synchronously in due-time order (no real waiting, no flakiness).
 */
export class VirtualClock implements SchedulerClock {
  private currentTime = 0;
  private readonly timers: ScheduledTimer[] = [];

  now(): number {
    return this.currentTime;
  }

  setTimer(callback: () => void, delayMs: number): TimerHandle {
    const handle = Symbol();
    this.timers.push({ handle, dueAt: this.currentTime + delayMs, callback });
    return handle;
  }

  clearTimer(handle: TimerHandle): void {
    const idx = this.timers.findIndex((t) => t.handle === handle);
    if (idx !== -1) this.timers.splice(idx, 1);
  }

  /** Advances time by `ms`, firing any timers that become due, in due-time order. */
  advance(ms: number): void {
    const target = this.currentTime + ms;
    for (;;) {
      const next = this.timers
        .filter((t) => t.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!next) break;
      const idx = this.timers.indexOf(next);
      this.timers.splice(idx, 1);
      this.currentTime = next.dueAt;
      next.callback();
    }
    this.currentTime = target;
  }
}
