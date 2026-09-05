export interface BroadcastEvent {
  seq: number;
  kind: string;
  payload: unknown;
}

/** In-process pub/sub for live SSE subscribers of a running execution. */
export class ExecutionHub {
  private readonly subscribers = new Map<string, Set<(event: BroadcastEvent) => void>>();

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
}
