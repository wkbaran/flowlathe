import { emptyFlowGraph } from "@flowlathe/core";
import { createFlow, openDb, runMigrations, startExecution, type OpenedDb } from "@flowlathe/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRetentionTimer } from "./retention.js";

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  opened.close();
});

function ageOutExecution(o: OpenedDb, executionId: string, daysAgo: number) {
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  o.sqlite.prepare("UPDATE executions SET status = 'finished', started_at = ?, ended_at = ? WHERE id = ?").run(at, at, executionId);
}

function executionExists(o: OpenedDb, executionId: string): boolean {
  return o.sqlite.prepare("SELECT 1 FROM executions WHERE id = ?").get(executionId) !== undefined;
}

describe("startRetentionTimer", () => {
  it("runs a sweep after initialDelayMs", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const { executionId } = startExecution(opened.db, flow.flowVersionId, "run");
    ageOutExecution(opened, executionId, 999);

    const stop = startRetentionTimer({ db: opened.db, initialDelayMs: 1000, intervalHours: 24 });
    vi.advanceTimersByTime(999);
    expect(executionExists(opened, executionId)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(executionExists(opened, executionId)).toBe(false);
    stop();
  });

  it("runs another sweep after each interval elapses", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const stop = startRetentionTimer({ db: opened.db, initialDelayMs: 1000, intervalHours: 1 });
    vi.advanceTimersByTime(1000); // first (empty) sweep

    const { executionId } = startExecution(opened.db, flow.flowVersionId, "run");
    ageOutExecution(opened, executionId, 999);

    vi.advanceTimersByTime(3600_000 - 1);
    expect(executionExists(opened, executionId)).toBe(true);

    vi.advanceTimersByTime(1);
    expect(executionExists(opened, executionId)).toBe(false);
    stop();
  });

  it("stop() prevents any further sweep", () => {
    const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
    const stop = startRetentionTimer({ db: opened.db, initialDelayMs: 1000, intervalHours: 1 });
    vi.advanceTimersByTime(1000);
    stop();

    const { executionId } = startExecution(opened.db, flow.flowVersionId, "run");
    ageOutExecution(opened, executionId, 999);

    vi.advanceTimersByTime(3600_000 * 5);
    expect(executionExists(opened, executionId)).toBe(true);
  });

  it("catches a throwing sweep and keeps the timer running", () => {
    // A genuinely broken DB (no migrations run) forces a real error out of gcAllExecutions —
    // its first query (against `flows`) fails because the table doesn't exist yet.
    const broken = openDb(":memory:");
    const stop = startRetentionTimer({ db: broken.db, initialDelayMs: 1000, intervalHours: 1 });

    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    // The interval timer must still have been armed despite the first sweep throwing.
    expect(() => vi.advanceTimersByTime(3600_000)).not.toThrow();

    stop();
    broken.close();
  });
});
