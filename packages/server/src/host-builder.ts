import type { RunEvent, Scheduler } from "@flowlathe/core";
import {
  appendRunEvent,
  beginStep,
  type Db,
  finishStep,
  recordFailedResponse,
  recordResponse,
  setExecutionStatus,
  SqliteBlobStore,
} from "@flowlathe/persistence";
import { createRun, createSuspendRegistry, type Run } from "@flowlathe/runtime";
import type { ExecutionHub } from "./execution-hub.js";

export interface BuiltHost {
  run: Run;
  resolveSuspended: (key: string, value: string) => void;
  emit: (event: RunEvent) => void;
}

/** The one place a `Run` gets wired to persistence + SSE, shared by run mode and step mode. */
export function buildHostAndRun(opts: {
  db: Db;
  hub: ExecutionHub;
  scheduler: Scheduler;
  executionId: string;
  branchId: string;
}): BuiltHost {
  const { db, hub, scheduler, executionId, branchId } = opts;
  const stepIdByNodeId = new Map<string, string>();
  const suspendRegistry = createSuspendRegistry();

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

  return { run, resolveSuspended: suspendRegistry.resolveSuspended, emit };
}
