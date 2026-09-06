import type { FlowGraph, RunEvent, Scheduler } from "@flowlathe/core";
import { runGraph } from "@flowlathe/interpreter";
import {
  appendRunEvent,
  beginStep,
  type Db,
  finishExecution,
  finishStep,
  recordFailedResponse,
  recordResponse,
  setExecutionStatus,
  SqliteBlobStore,
  startExecution,
} from "@flowlathe/persistence";
import { createRun, createSuspendRegistry } from "@flowlathe/runtime";
import type { ExecutionHub } from "./execution-hub.js";

export interface RunFlowOptions {
  db: Db;
  hub: ExecutionHub;
  scheduler: Scheduler;
  flowVersionId: string;
  graph: FlowGraph;
}

export interface RunFlowHandle {
  executionId: string;
  branchId: string;
}

/** Kicks off a flow execution asynchronously; callers get the ids back immediately. */
export function runFlow(opts: RunFlowOptions): RunFlowHandle {
  const { db, hub, scheduler, flowVersionId, graph } = opts;
  const { executionId, branchId } = startExecution(db, flowVersionId);
  const stepIdByNodeId = new Map<string, string>();
  const suspendRegistry = createSuspendRegistry();
  hub.registerResolver(executionId, suspendRegistry.resolveSuspended);

  const emit = (event: RunEvent): void => {
    const seq = appendRunEvent(db, { executionId, branchId, kind: event.kind, payload: event });
    hub.publish(executionId, { seq, kind: event.kind, payload: event });
  };

  const run = createRun({
    host: {
      scheduler,
      blobs: new SqliteBlobStore(db),
      clock: { now: () => Date.now() },
      ...suspendRegistry,
      emit: (event) => {
        emit(event);

        if (event.kind === "node_started") {
          stepIdByNodeId.set(event.nodeId, beginStep(db, { branchId, nodeId: event.nodeId }));
        } else if (event.kind === "node_finished") {
          const stepId = stepIdByNodeId.get(event.nodeId);
          if (stepId) {
            finishStep(db, stepId, "done");
            recordResponse(db, {
              executionId,
              branchId,
              stepId,
              nodeId: event.nodeId,
              renderedPrompt: event.renderedPrompt,
              content: event.output,
              finishReason: event.finishReason,
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
              latencyMs: event.latencyMs,
            });
          }
          setExecutionStatus(db, executionId, "running");
        } else if (event.kind === "node_failed") {
          const stepId = stepIdByNodeId.get(event.nodeId);
          if (stepId) {
            finishStep(db, stepId, "failed");
            recordFailedResponse(db, { executionId, branchId, stepId, nodeId: event.nodeId, error: event.error });
          }
        } else if (event.kind === "node_suspended") {
          setExecutionStatus(db, executionId, "awaiting_input");
        }
      },
    },
  });

  const hasOutgoing = new Set(graph.edges.map((e) => e.source));
  const terminalNodeIds = graph.nodes.map((n) => n.id).filter((id) => !hasOutgoing.has(id));

  runGraph({ graph, run })
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
