/**
 * A cached wrapper around an async liveness/auth probe, for use as a `ToolRegistration.
 * unavailableReason`. That callback is called synchronously — on a request path (`/run`,
 * `/step-start`) and on every `GraphEngine` construction, including step-mode restores — so it
 * must never block on a network round trip. The first call kicks off a background probe and
 * optimistically reports reachable (so registration doesn't spuriously fail before the first
 * probe lands); every call after that returns the last known result and only re-probes once the
 * TTL has elapsed. Shared by SearXNG's reachability check and Firecrawl's auth check.
 */
export class CachedLivenessProbe {
  private reachable = true;
  private lastCheckedAt = 0;
  private checking = false;

  constructor(
    private readonly probeFn: () => Promise<boolean>,
    private readonly ttlMs = 60_000,
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
    this.probeFn()
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
