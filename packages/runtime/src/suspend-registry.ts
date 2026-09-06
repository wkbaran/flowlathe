import type { RuntimeHost, SuspendReason } from "@flowlathe/core";

/** A minimal in-memory `{suspend, resolveSuspended}` pair shared by every RuntimeHost. */
export function createSuspendRegistry(): Pick<RuntimeHost, "suspend" | "resolveSuspended"> {
  const pending = new Map<string, (value: string) => void>();

  return {
    suspend(key: string, _reason: SuspendReason): Promise<string> {
      return new Promise<string>((resolve) => {
        pending.set(key, resolve);
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
