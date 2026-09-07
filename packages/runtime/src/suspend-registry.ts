import type { RunControl, RuntimeHost, SuspendReason } from "@flowlathe/core";

/** A minimal in-memory `{suspend, resolveSuspended}` pair shared by every RuntimeHost. Rejects
 *  every pending suspend on `control`'s abort — without this, `GraphEngine.runToCompletion`'s
 *  cancel-then-drain (PLAN-CANCELLATION.md D1) hangs forever on a fan-out where one sibling fails
 *  and another is parked in a `pause`/`userInput` node (see CLAUDE.md). */
export function createSuspendRegistry(control: RunControl): Pick<RuntimeHost, "suspend" | "resolveSuspended"> {
  const pending = new Map<string, (value: string) => void>();

  return {
    suspend(key: string, _reason: SuspendReason): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        if (control.signal.aborted) {
          reject(control.signal.reason);
          return;
        }
        const onAbort = (): void => {
          pending.delete(key);
          reject(control.signal.reason);
        };
        control.signal.addEventListener("abort", onAbort, { once: true });
        pending.set(key, (value) => {
          control.signal.removeEventListener("abort", onAbort);
          resolve(value);
        });
      });
    },
    resolveSuspended(key: string, value: string): void {
      const resolve = pending.get(key);
      if (!resolve) throw new Error(`no suspended activation registered for key "${key}"`);
      pending.delete(key);
      resolve(value);
    },
  };
}
