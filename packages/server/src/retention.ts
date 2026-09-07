import { gcAllExecutions, type Db } from "@flowlathe/persistence";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface RetentionTimerOptions {
  db: Db;
  /** FLOWLATHE_EXECUTION_GC_INTERVAL_HOURS, else 24. */
  intervalHours?: number;
  /** Delay before the first sweep, so `listen()` isn't blocked. Default 30_000. */
  initialDelayMs?: number;
}

/**
 * Boot sweep + recurring timer for `gcAllExecutions` — mirrors `watchFlowsDir`'s "start returns a
 * stop function" shape. The boot sweep is what handles an upgrade onto a large existing DB, a
 * policy change via env, and a flow that stopped running entirely; the interval is what handles a
 * server that stays up for weeks with a Discord trigger firing all day. Both timers are `.unref()`d
 * so a pending sweep never holds the process open, and a throwing sweep is caught and logged —
 * never allowed to take the server down.
 */
export function startRetentionTimer(opts: RetentionTimerOptions): () => void {
  const intervalHours = opts.intervalHours ?? envInt("FLOWLATHE_EXECUTION_GC_INTERVAL_HOURS", 24);
  const initialDelayMs = opts.initialDelayMs ?? 30_000;
  const db = opts.db;

  let intervalTimer: ReturnType<typeof setInterval> | undefined;

  const runSweep = () => {
    try {
      gcAllExecutions(db);
    } catch (err) {
      console.error(`[retention] sweep failed: ${(err as Error).message}`);
    }
  };

  const initialTimer = setTimeout(() => {
    runSweep();
    intervalTimer = setInterval(runSweep, intervalHours * 3600_000);
    intervalTimer.unref();
  }, initialDelayMs);
  initialTimer.unref();

  return () => {
    clearTimeout(initialTimer);
    if (intervalTimer) clearInterval(intervalTimer);
  };
}
