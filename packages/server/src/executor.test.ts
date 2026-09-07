import type { FlowGraph } from "@flowlathe/core";
import {
  createFlow,
  getExecution,
  listRunEventsSince,
  type OpenedDb,
  openDb,
  runMigrations,
} from "@flowlathe/persistence";
import { MockProviderAdapter, SimpleScheduler } from "@flowlathe/providers";
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionHub } from "./execution-hub.js";
import { runFlow } from "./executor.js";

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
});

/** Mirrors `packages/testing/src/golden/failing-fan-out.ts` (PLAN-CANCELLATION.md §5.1) —
 *  duplicated rather than imported so `@flowlathe/server` doesn't grow a new workspace
 *  dependency on `@flowlathe/testing` for one fixture. Two prompt nodes, no edges, so both land
 *  in one fan-out level: `boom` fails almost immediately, `slow` is parked in an interruptible
 *  2s sleep that only resolves early if the mock adapter's `req.signal` actually gets aborted. */
function failingFanOutGraph(): FlowGraph {
  return {
    nodes: [
      { id: "boom", type: "prompt", position: { x: 0, y: 0 }, data: { template: "FAIL: boom node exploded", providerId: "mock", modelId: "m" } },
      { id: "slow", type: "prompt", position: { x: 0, y: 1 }, data: { template: "DELAY_MS: 2000 slow node", providerId: "mock", modelId: "m" } },
    ],
    edges: [],
    state: [],
  };
}

async function waitForExecutionToFinish(db: OpenedDb["db"], executionId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const execution = getExecution(db, executionId);
    if (execution && (execution.status === "finished" || execution.status === "failed")) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`execution "${executionId}" did not settle in time`);
}

describe("runFlow — cancellation (PLAN-CANCELLATION.md, definition of done)", () => {
  it(
    "stops a failing fan-out's sibling: run_failed is the last event, no node_* event follows it, and the cancelled sibling records node_cancelled/steps.status=cancelled with no responses row",
    async () => {
      const flow = createFlow(opened.db, "Failing Fan-Out", failingFanOutGraph());
      const hub = new ExecutionHub();
      const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 4 } });

      const start = Date.now();
      const { executionId, branchId } = runFlow({
        db: opened.db,
        hub,
        scheduler,
        flowVersionId: flow.flowVersionId,
        graph: flow.graph,
      });
      await waitForExecutionToFinish(opened.db, executionId);

      // The execution row flips to "failed" almost immediately (boom fails within a few
      // microtasks) — that alone doesn't prove "slow" was actually stopped, only that nothing is
      // blocking on it. Wait past "slow"'s full un-cancelled 2s delay before reading events, so
      // an uncancelled sibling's late `node_finished` (the bug this test exists to catch) has
      // time to actually land if it's going to.
      const elapsed = Date.now() - start;
      if (elapsed < 2300) await new Promise((r) => setTimeout(r, 2300 - elapsed));

      const execution = getExecution(opened.db, executionId);
      expect(execution?.status).toBe("failed");

      const events = listRunEventsSince(opened.db, executionId, 0);
      const lastEvent = events[events.length - 1];
      expect(lastEvent?.kind).toBe("run_failed");
      const afterRunFailed = events.slice(events.findIndex((e) => e.kind === "run_failed") + 1);
      expect(afterRunFailed).toEqual([]);

      const kinds = events.map((e) => e.kind);
      expect(kinds).toContain("node_failed");
      expect(kinds).toContain("node_cancelled");

      const steps = opened.sqlite
        .prepare("SELECT node_id, status FROM steps WHERE branch_id = ?")
        .all(branchId) as { node_id: string; status: string }[];
      const slowStep = steps.find((s) => s.node_id === "slow");
      expect(slowStep?.status).toBe("cancelled");

      const responseRows = opened.sqlite
        .prepare("SELECT node_id FROM responses WHERE execution_id = ?")
        .all(executionId) as { node_id: string }[];
      expect(responseRows.some((r) => r.node_id === "slow")).toBe(false);
    },
    10_000,
  );
});
