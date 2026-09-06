import type { RunEvent, Scheduler, StateDecl } from "@flowlathe/core";
import {
  appendRunEvent,
  beginStep,
  type Db,
  finishStep,
  recordContextCompaction,
  recordFailedResponse,
  recordResponse,
  recordStateRead,
  recordStateWrite,
  setExecutionStatus,
  SqliteBlobStore,
} from "@flowlathe/persistence";
import {
  createContextStore,
  createLlmConfigStore,
  createRun,
  createStateStore,
  createSuspendRegistry,
  type Run,
} from "@flowlathe/runtime";
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
  stateDecls: StateDecl[];
  /** Past writes on this branch to resume from — how step mode keeps state across `stepOnce`
   *  calls, each of which builds a fresh host (see CLAUDE.md for the branch-fork scope gap). */
  stateReplay?: { entry: string; value: unknown; seq: number }[];
}): BuiltHost {
  const { db, hub, scheduler, executionId, branchId, stateDecls, stateReplay } = opts;
  const stepIdByNodeId = new Map<string, string>();
  const suspendRegistry = createSuspendRegistry();

  const emit = (event: RunEvent): void => {
    const seq = appendRunEvent(db, { executionId, branchId, kind: event.kind, payload: event });
    hub.publish(executionId, { seq, kind: event.kind, payload: event });
  };

  const hostEmit = (event: RunEvent): void => {
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
    } else if (event.kind === "state_write") {
      recordStateWrite(db, {
        branchId,
        stepId: event.activationKey ? stepIdByNodeId.get(event.activationKey) : undefined,
        entry: event.entry,
        value: event.value,
        merge: event.merge,
        seq: event.seq,
      });
    } else if (event.kind === "state_read") {
      recordStateRead(db, {
        branchId,
        stepId: event.activationKey ? stepIdByNodeId.get(event.activationKey) : undefined,
        entry: event.entry,
        seqSeen: event.seqSeen,
      });
    } else if (event.kind === "context_compacted") {
      recordContextCompaction(db, {
        executionId,
        nodeId: event.nodeId,
        method: event.method,
        sourceMessages: event.beforeMessages,
        resultMessages: event.afterMessages,
      });
    }
  };

  const run = createRun({
    host: {
      scheduler,
      blobs: new SqliteBlobStore(db),
      clock: { now: () => Date.now() },
      state: createStateStore(hostEmit, { decls: stateDecls, replay: stateReplay }),
      llmConfig: createLlmConfigStore(),
      context: createContextStore(),
      ...suspendRegistry,
      emit: hostEmit,
    },
  });

  return { run, resolveSuspended: suspendRegistry.resolveSuspended, emit };
}
