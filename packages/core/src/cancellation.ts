import type { RunEvent } from "./contracts.js";

/** One execution's cancellation channel. Ambient on `RuntimeHost` (same family as `state`/
 *  `context`/`tools`) so every node runner reaches it without a signature change. `cancel` is
 *  idempotent: a nested Loop/Map sub-engine cancels first, then the outer engine cancels again
 *  when the Loop/Map node's own promise rejects. */
export interface RunControl {
  readonly signal: AbortSignal;
  cancel(reason: unknown): void;
}

/** Thrown into everything still in flight when a run is cancelled. Carries the original failure
 *  as `cause` so an operator can still see *why* the run stopped, while `message` makes clear
 *  this node did not itself fail. */
export class RunCancelled extends Error {
  constructor(reason: unknown) {
    super("run cancelled");
    this.name = "RunCancelled";
    this.cause = reason;
  }
}

/** True for our own cancellation and for a platform abort (`fetch` rejects with the
 *  `AbortController.abort(reason)` argument on Node, but a timeout or a nested `AbortSignal`
 *  can still surface a bare `AbortError` DOMException). */
export function isCancellation(err: unknown): boolean {
  if (err instanceof RunCancelled) return true;
  return err instanceof Error && err.name === "AbortError";
}

/** The event a node runner's catch block emits: `node_cancelled` when the error is a
 *  cancellation, `node_failed` otherwise. One policy, one place — every runner's catch becomes
 *  `ctx.emit(nodeFailureEvent(spec.id, err)); throw err;`. */
export function nodeFailureEvent(nodeId: string, err: unknown): RunEvent {
  if (isCancellation(err)) {
    return { kind: "node_cancelled", nodeId, reason: err instanceof Error ? err.message : String(err) };
  }
  return { kind: "node_failed", nodeId, error: err instanceof Error ? err.message : String(err) };
}

/** Wraps `AbortController`, wrapping the reason once: aborting with the *raw* failure would make
 *  every cancelled sibling report the failing node's own error as its own, exactly the confusing
 *  outcome `node_cancelled` exists to avoid. */
export function createRunControl(): RunControl {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    cancel(reason: unknown) {
      if (controller.signal.aborted) return;
      controller.abort(reason instanceof RunCancelled ? reason : new RunCancelled(reason));
    },
  };
}

/** `Promise.all` with D1 semantics (PLAN-CANCELLATION.md): on the first rejection, cancel the
 *  run, then wait for every other promise to settle, then throw. The reported error is the
 *  lowest-index rejection, not the first by time, so two engines running the same graph report
 *  the same one. Attaching the cancel *per promise* (rather than after `allSettled` resolves)
 *  matters: it fires at rejection time, so a sibling checking `control.signal` mid-flight
 *  actually observes the abort instead of running to completion first. */
export async function allOrCancel<T>(control: RunControl, promises: Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(
    promises.map((p) =>
      p.catch((err: unknown) => {
        control.cancel(err);
        throw err;
      }),
    ),
  );
  const failure = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (failure) throw failure.reason;
  return settled.map((s) => (s as PromiseFulfilledResult<T>).value);
}
