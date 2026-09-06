export class LoopLimitExceeded extends Error {
  constructor(maxIterations: number) {
    super(`loop exceeded maxIterations (${maxIterations})`);
    this.name = "LoopLimitExceeded";
  }
}

/** Runs `body` repeatedly, threading its return value back in as the next accumulator. */
export async function loopUntil(
  init: string,
  opts: { maxIterations: number; stopValue: string },
  body: (acc: string, i: number) => Promise<string>,
): Promise<string> {
  let acc = init;
  for (let i = 0; i < opts.maxIterations; i++) {
    acc = await body(acc, i);
    if (acc === opts.stopValue) return acc;
  }
  throw new LoopLimitExceeded(opts.maxIterations);
}

/** Runs `body` over `items` with bounded concurrency, returning results in input order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  opts: { concurrency: number },
  body: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await body(items[i] as T, i);
    }
  }
  const workerCount = Math.max(1, Math.min(opts.concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
