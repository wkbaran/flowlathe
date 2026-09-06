import type { FlowGraph, PortSlot, Scheduler } from "@flowlathe/core";
import { GraphEngine, type EngineSnapshot } from "@flowlathe/interpreter";
import {
  createBranch,
  createSnapshot,
  type Db,
  finishExecution,
  getBlob,
  getBranch,
  getSnapshot,
  listSnapshotsForBranch,
  listStateWritesForBranch,
  putBlob,
  startExecution,
} from "@flowlathe/persistence";
import type { ExecutionHub } from "./execution-hub.js";
import { buildHostAndRun } from "./host-builder.js";

type SerializedPortSlot = { kind: "value"; ref: string } | { kind: "never"; reason: string };

interface SerializedSnapshotPayload {
  outputs: Record<string, Record<string, SerializedPortSlot>>;
}

/** Snapshot rows stay small: port values are content-addressed blob refs, never inline text. */
function serializeSnapshot(db: Db, snapshot: EngineSnapshot): SerializedSnapshotPayload {
  const outputs: SerializedSnapshotPayload["outputs"] = {};
  for (const [nodeId, slots] of Object.entries(snapshot.outputs)) {
    const outSlots: Record<string, SerializedPortSlot> = {};
    for (const [port, slot] of Object.entries(slots)) {
      if (slot.kind === "empty") throw new Error(`unexpected empty port slot in snapshot: ${nodeId}.${port}`);
      outSlots[port] =
        slot.kind === "value" ? { kind: "value", ref: putBlob(db, Buffer.from(slot.value, "utf-8")) } : slot;
    }
    outputs[nodeId] = outSlots;
  }
  return { outputs };
}

function deserializeSnapshot(db: Db, payload: unknown): EngineSnapshot {
  const parsed = payload as SerializedSnapshotPayload;
  const outputs: EngineSnapshot["outputs"] = {};
  for (const [nodeId, slots] of Object.entries(parsed.outputs ?? {})) {
    const outSlots: Record<string, PortSlot> = {};
    for (const [port, slot] of Object.entries(slots)) {
      if (slot.kind === "value") {
        const bytes = getBlob(db, slot.ref);
        outSlots[port] = { kind: "value", value: bytes ? bytes.toString("utf-8") : "" };
      } else {
        outSlots[port] = slot as PortSlot;
      }
    }
    outputs[nodeId] = outSlots;
  }
  return { outputs };
}

export function startStepExecution(
  db: Db,
  flowVersionId: string,
): { executionId: string; branchId: string; snapshotId: string } {
  const { executionId, branchId } = startExecution(db, flowVersionId, "step");
  const snapshot = createSnapshot(db, { branchId, stepIndex: 0, payload: serializeSnapshot(db, { outputs: {} }) });
  return { executionId, branchId, snapshotId: snapshot.id };
}

export interface StepOnceOptions {
  db: Db;
  hub: ExecutionHub;
  scheduler: Scheduler;
  graph: FlowGraph;
  executionId: string;
  branchId: string;
}

export interface StepOutcome {
  done: boolean;
  nodeId?: string;
  snapshotId?: string;
}

function latestSnapshot(db: Db, branchId: string) {
  const snapshots = listSnapshotsForBranch(db, branchId);
  const latest = snapshots.sort((a, b) => b.stepIndex - a.stepIndex)[0];
  if (!latest) throw new Error(`branch "${branchId}" has no snapshots yet`);
  return latest;
}

/** Restores the branch's latest snapshot, dispatches exactly one ready activation, and — if
 *  the graph isn't already fully settled — persists the resulting snapshot as the new tip. */
export async function stepOnce(opts: StepOnceOptions): Promise<StepOutcome> {
  const { db, hub, scheduler, graph, executionId, branchId } = opts;
  const latest = latestSnapshot(db, branchId);

  const { run, resolveSuspended, emit } = buildHostAndRun({
    db,
    hub,
    scheduler,
    executionId,
    branchId,
    stateDecls: graph.state,
    stateReplay: listStateWritesForBranch(db, branchId),
  });
  hub.registerResolver(executionId, resolveSuspended);
  try {
    const engine = GraphEngine.restore(graph, run, deserializeSnapshot(db, latest.payload));
    const result = await engine.step();

    if (!result) {
      const hasOutgoing = new Set(graph.edges.map((e) => e.source));
      const terminalNodeIds = graph.nodes.map((n) => n.id).filter((id) => !hasOutgoing.has(id));
      const outputs = engine.collectOutputs();
      run.finish(Object.fromEntries(terminalNodeIds.map((id) => [id, outputs[id]])));
      finishExecution(db, executionId, "finished");
      return { done: true };
    }

    const snapshot = createSnapshot(db, {
      branchId,
      stepIndex: latest.stepIndex + 1,
      parentSnapshotId: latest.id,
      payload: serializeSnapshot(db, engine.snapshot()),
    });
    return { done: false, nodeId: result.nodeId, snapshotId: snapshot.id };
  } catch (err) {
    const message = (err as Error).message;
    emit({ kind: "run_failed", error: message });
    finishExecution(db, executionId, "failed", { message });
    throw err;
  } finally {
    hub.unregisterResolver(executionId);
  }
}

export interface StepBackResult {
  branchId: string;
  snapshotId: string;
}

/** Step-back-with-fork: the old branch is retained, never truncated. */
export function stepBack(db: Db, snapshotId: string, label?: string): StepBackResult {
  const original = getSnapshot(db, snapshotId);
  if (!original) throw new Error(`snapshot not found: ${snapshotId}`);
  const originalBranch = getBranch(db, original.branchId);
  if (!originalBranch) throw new Error(`branch not found: ${original.branchId}`);

  const newBranch = createBranch(db, {
    executionId: originalBranch.executionId,
    parentBranchId: originalBranch.id,
    forkedFromSnapshotId: original.id,
    label,
  });
  const newSnapshot = createSnapshot(db, {
    branchId: newBranch.id,
    stepIndex: original.stepIndex,
    parentSnapshotId: original.id,
    payload: original.payload,
  });
  return { branchId: newBranch.id, snapshotId: newSnapshot.id };
}
