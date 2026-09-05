import type { ProviderAdapter, ProviderCallRequest, ProviderCallResult, Scheduler } from "@flowlathe/core";

class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    this.available = capacity;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available -= 1;
    return () => this.release();
  }

  private release(): void {
    this.available += 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export interface ProviderRegistration {
  adapter: ProviderAdapter;
  maxParallel: number;
}

/**
 * Layer-1 gates only: a per-provider concurrency semaphore. Model-affinity batching
 * (residency-aware queue scoring) is a slice-2 concern layered on top of this.
 */
export class SimpleScheduler implements Scheduler {
  private readonly providers = new Map<string, { adapter: ProviderAdapter; semaphore: Semaphore }>();

  constructor(providers: Record<string, ProviderRegistration>) {
    for (const [providerId, reg] of Object.entries(providers)) {
      this.providers.set(providerId, { adapter: reg.adapter, semaphore: new Semaphore(reg.maxParallel) });
    }
  }

  async submit(req: ProviderCallRequest): Promise<ProviderCallResult> {
    const entry = this.providers.get(req.providerId);
    if (!entry) throw new Error(`unknown provider: "${req.providerId}"`);
    const release = await entry.semaphore.acquire();
    try {
      return await entry.adapter.call(req);
    } finally {
      release();
    }
  }
}
