import type { SearxngClient } from "./client.js";

const DEFAULT_TTL_MS = 60_000;

/**
 * `unavailableReason()` is called synchronously, on a request path (`/run`) and on every
 * `GraphEngine` construction including step-mode restores — it must never block on a network
 * round trip. This wraps `SearxngClient.isReachable()` in a cache: the first call kicks off a
 * background probe and optimistically reports reachable (so registration doesn't spuriously
 * fail before the first probe lands); every call after that returns the last known result and
 * only re-probes once the TTL has elapsed.
 */
export class CachedLivenessProbe {
  private reachable = true;
  private lastCheckedAt = 0;
  private checking = false;

  constructor(
    private readonly client: SearxngClient,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {
    this.refresh();
  }

  isReachable(): boolean {
    if (Date.now() - this.lastCheckedAt >= this.ttlMs) this.refresh();
    return this.reachable;
  }

  private refresh(): void {
    if (this.checking) return;
    this.checking = true;
    this.client
      .isReachable()
      .then((ok) => {
        this.reachable = ok;
      })
      .catch(() => {
        this.reachable = false;
      })
      .finally(() => {
        this.lastCheckedAt = Date.now();
        this.checking = false;
      });
  }
}
