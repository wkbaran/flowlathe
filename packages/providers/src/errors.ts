export class ProviderCallError extends Error {
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, opts: { status?: number | undefined; retryAfterMs?: number | undefined } = {}) {
    super(message);
    this.name = "ProviderCallError";
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export type FailureClass = "rate-limited" | "transient" | "fatal";

export function classifyFailure(err: unknown): FailureClass {
  if (err instanceof ProviderCallError) {
    if (err.status === 429) return "rate-limited";
    if (err.status !== undefined && err.status >= 500) return "transient";
    if (err.status !== undefined) return "fatal";
  }
  const code = (err as { cause?: { code?: string }; code?: string })?.cause?.code ?? (err as { code?: string })?.code;
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED" || code === "EPIPE") {
    return "transient";
  }
  return "fatal";
}
