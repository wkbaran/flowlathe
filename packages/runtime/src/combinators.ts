import { allOrCancel, type RunControl } from "@flowlathe/core";

export class LoopLimitExceeded extends Error {
  constructor(maxIterations: number) {
    super(`loop exceeded maxIterations (${maxIterations})`);
    this.name = "LoopLimitExceeded";
  }
}

/** Runs `body` repeatedly, threading its return value back in as the next accumulator. Checks
 *  `control` at the top of each iteration (PLAN-CANCELLATION.md S4) so a cancelled run doesn't
 *  keep looping after a sibling elsewhere has failed. */
export async function loopUntil(
  init: string,
  opts: { maxIterations: number; stopValue: string; control: RunControl },
  body: (acc: string, i: number) => Promise<string>,
): Promise<string> {
  let acc = init;
  for (let i = 0; i < opts.maxIterations; i++) {
    opts.control.signal.throwIfAborted();
    acc = await body(acc, i);
    if (acc === opts.stopValue) return acc;
  }
  throw new LoopLimitExceeded(opts.maxIterations);
}

/** Runs `body` over `items` with bounded concurrency, returning results in input order. On the
 *  first rejection, `allOrCancel` cancels `control` and every worker's `for(;;)` loop returns
 *  early rather than pulling a new item — otherwise a large map keeps starting fresh iterations
 *  after the first one fails (PLAN-CANCELLATION.md S4). */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  opts: { concurrency: number; control: RunControl },
  body: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      if (opts.control.signal.aborted) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await body(items[i] as T, i);
    }
  }
  const workerCount = Math.max(1, Math.min(opts.concurrency, items.length));
  await allOrCancel(opts.control, Array.from({ length: workerCount }, () => worker()));
  return results;
}
