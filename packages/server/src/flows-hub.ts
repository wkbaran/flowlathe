/** Un-keyed pub/sub for "a `.flow` file changed on disk" — same shape as `ExecutionHub`, minus
 *  the per-execution keying (there's only one topic: the flows list as a whole). S4's canvas
 *  consumes this to offer a reload when the open flow's file changed underneath it; for now it's
 *  wired up server-side only, per PLAN-FLOW-DSL.md §4.1's "broadcast an SSE/`/api/flows`
 *  invalidation." */
export interface FlowInvalidatedEvent {
  slug: string;
}

export class FlowsHub {
  private readonly subscribers = new Set<(event: FlowInvalidatedEvent) => void>();

  publish(event: FlowInvalidatedEvent): void {
    for (const fn of this.subscribers) fn(event);
  }

  subscribe(fn: (event: FlowInvalidatedEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
