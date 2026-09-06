export interface BroadcastEvent {
  seq: number;
  kind: string;
  payload: unknown;
}

/** In-process pub/sub for live SSE subscribers of a running execution, plus its suspend/resume hook. */
export class ExecutionHub {
  private readonly subscribers = new Map<string, Set<(event: BroadcastEvent) => void>>();
  private readonly resolvers = new Map<string, (key: string, value: string) => void>();

  publish(executionId: string, event: BroadcastEvent): void {
    for (const fn of this.subscribers.get(executionId) ?? []) fn(event);
  }

  subscribe(executionId: string, fn: (event: BroadcastEvent) => void): () => void {
    let set = this.subscribers.get(executionId);
    if (!set) {
      set = new Set();
      this.subscribers.set(executionId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.subscribers.delete(executionId);
    };
  }

  registerResolver(executionId: string, resolve: (key: string, value: string) => void): void {
    this.resolvers.set(executionId, resolve);
  }

  unregisterResolver(executionId: string): void {
    this.resolvers.delete(executionId);
  }

  resume(executionId: string, activationKey: string, value: string): void {
    const resolve = this.resolvers.get(executionId);
    if (!resolve) throw new Error(`execution "${executionId}" is not awaiting input (or has already finished)`);
    resolve(activationKey, value);
  }
}
