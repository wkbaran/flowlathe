import type { FlowGraph, Scheduler, ToolRegistration } from "@flowlathe/core";
import { runGraph } from "@flowlathe/interpreter";
import { type Db, finishExecution, startExecution } from "@flowlathe/persistence";
import type { ExecutionHub } from "./execution-hub.js";
import { buildHostAndRun } from "./host-builder.js";

export interface RunFlowOptions {
  db: Db;
  hub: ExecutionHub;
  scheduler: Scheduler;
  flowVersionId: string;
  graph: FlowGraph;
  pluginToolsets?: ToolRegistration[] | undefined;
  /** See `RunGraphOptions.seed` — how a trigger source (Discord) starts a headless run with a
   *  `trigger` node's outputs already filled from the real event. */
  seed?: Record<string, Record<string, string>> | undefined;
}

export interface RunFlowHandle {
  executionId: string;
  branchId: string;
}

/** Kicks off a flow execution asynchronously; callers get the ids back immediately. */
export function runFlow(opts: RunFlowOptions): RunFlowHandle {
  const { db, hub, scheduler, flowVersionId, graph, pluginToolsets, seed } = opts;
  const { executionId, branchId } = startExecution(db, flowVersionId, "run");
  const { run, resolveSuspended, emit } = buildHostAndRun({
    db,
    hub,
    scheduler,
    executionId,
    branchId,
    stateDecls: graph.state,
    pluginToolsets,
  });
  hub.registerResolver(executionId, resolveSuspended);

  const hasOutgoing = new Set(graph.edges.map((e) => e.source));
  const terminalNodeIds = graph.nodes.map((n) => n.id).filter((id) => !hasOutgoing.has(id));

  runGraph({ graph, run, seed })
    .then(({ outputs }) => {
      run.finish(Object.fromEntries(terminalNodeIds.map((id) => [id, outputs[id]])));
      finishExecution(db, executionId, "finished");
    })
    .catch((err: unknown) => {
      const message = (err as Error).message;
      emit({ kind: "run_failed", error: message });
      finishExecution(db, executionId, "failed", { message });
    })
    .finally(() => hub.unregisterResolver(executionId));

  return { executionId, branchId };
}
