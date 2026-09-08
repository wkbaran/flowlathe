import type { ServerResponse } from "node:http";
import { diffGraphs, isSemanticChange, type Scheduler, type ToolRegistration } from "@flowlathe/core";
import {
  getBranch,
  getFlow,
  type Db,
  getExecution,
  getFlowVersionRow,
  getSnapshot,
  getStateSnapshot,
  listBranches,
  listResponses,
  listRunEventsSince,
  listSnapshotsForBranch,
  listStateLineage,
} from "@flowlathe/persistence";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExecutionHub } from "../execution-hub.js";
import { getLatestGraphForFlowVersionFileAware } from "../flow-store.js";
import { stepBack, stepOnce } from "../stepper.js";

const ResumeBody = z.object({ activationKey: z.string().min(1), value: z.string() });
const StepBody = z.object({ branchId: z.string().min(1) });
const StepBackBody = z.object({ snapshotId: z.string().min(1), label: z.string().optional() });

export interface ExecutionRouteDeps {
  db: Db;
  hub: ExecutionHub;
  scheduler: Scheduler;
  pluginToolsets?: ToolRegistration[] | undefined;
  flowsDir: string;
}

/** There is no auth boundary today — this is a client-bug guard, not an authorization control
 *  (see the handoff doc's "Execution routes don't verify resource ownership" item). Without it, a
 *  `branchId`/`snapshotId` for a *different* execution than the one named in the URL silently
 *  operates on the wrong branch instead of 404ing. Returns the branch on success so callers don't
 *  re-fetch it. */
function branchOwnedByExecution(db: Db, branchId: string, executionId: string): ReturnType<typeof getBranch> | undefined {
  const branch = getBranch(db, branchId);
  if (!branch || branch.executionId !== executionId) return undefined;
  return branch;
}

export function registerExecutionRoutes(app: FastifyInstance, deps: ExecutionRouteDeps): void {
  const { db, hub, scheduler, pluginToolsets, flowsDir } = deps;

  app.get<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    "/api/executions/:id",
    async (request, reply) => {
      const execution = getExecution(db, request.params.id);
      if (!execution) return reply.code(404).send({ error: "execution not found" });
      return {
        execution,
        responses: listResponses(db, request.params.id, request.query.branchId),
        ...describeFlowVersionProvenance(db, execution.flowVersionId),
      };
    },
  );

  /** An execution's flow, as text — even after the flow (or its file) is gone. §4.2/definition-
   *  of-done: "an execution whose flow file was deleted still shows its graph and its DSL text."
   *  Deliberately reads the pinned version's own row (`sourceText`), not the live file — an
   *  execution's own record of what it ran must never drift just because the flow moved on. */
  app.get<{ Params: { id: string } }>("/api/executions/:id/flow-source", async (request, reply) => {
    const execution = getExecution(db, request.params.id);
    if (!execution) return reply.code(404).send({ error: "execution not found" });
    const version = getFlowVersionRow(db, execution.flowVersionId);
    if (!version) return reply.code(404).send({ error: "flow version not found" });
    return { graph: version.graph, sourceText: version.sourceText };
  });

  app.get<{ Params: { id: string } }>("/api/executions/:id/branches", async (request, reply) => {
    const execution = getExecution(db, request.params.id);
    if (!execution) return reply.code(404).send({ error: "execution not found" });
    return listBranches(db, request.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { branchId: string } }>(
    "/api/executions/:id/snapshots",
    async (request, reply) => {
      if (!request.query.branchId) return reply.code(400).send({ error: "branchId query param is required" });
      if (!branchOwnedByExecution(db, request.query.branchId, request.params.id)) {
        return reply.code(404).send({ error: "branch not found" });
      }
      return listSnapshotsForBranch(db, request.query.branchId);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { branchId: string } }>(
    "/api/executions/:id/state",
    async (request, reply) => {
      if (!request.query.branchId) return reply.code(400).send({ error: "branchId query param is required" });
      if (!branchOwnedByExecution(db, request.query.branchId, request.params.id)) {
        return reply.code(404).send({ error: "branch not found" });
      }
      return getStateSnapshot(db, request.query.branchId);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { branchId: string } }>(
    "/api/executions/:id/state-lineage",
    async (request, reply) => {
      if (!request.query.branchId) return reply.code(400).send({ error: "branchId query param is required" });
      if (!branchOwnedByExecution(db, request.query.branchId, request.params.id)) {
        return reply.code(404).send({ error: "branch not found" });
      }
      return listStateLineage(db, request.query.branchId);
    },
  );

  app.post<{ Params: { id: string } }>("/api/executions/:id/step", async (request, reply) => {
    const parsed = StepBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const execution = getExecution(db, request.params.id);
    if (!execution) return reply.code(404).send({ error: "execution not found" });
    if (!branchOwnedByExecution(db, parsed.data.branchId, request.params.id)) {
      return reply.code(404).send({ error: "branch not found" });
    }
    const graph = getLatestGraphForFlowVersionFileAware(db, flowsDir, execution.flowVersionId);
    if (!graph) return reply.code(500).send({ error: "flow version graph not found" });

    try {
      const outcome = await stepOnce({
        db,
        hub,
        scheduler,
        graph,
        executionId: request.params.id,
        branchId: parsed.data.branchId,
        pluginToolsets,
      });
      return outcome;
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/executions/:id/step-back", async (request, reply) => {
    const parsed = StepBackBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const snapshot = getSnapshot(db, parsed.data.snapshotId);
    if (!snapshot || !branchOwnedByExecution(db, snapshot.branchId, request.params.id)) {
      return reply.code(404).send({ error: "snapshot not found" });
    }
    try {
      return stepBack(db, parsed.data.snapshotId, parsed.data.label);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/executions/:id/resume", async (request, reply) => {
    const parsed = ResumeBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    try {
      hub.resume(request.params.id, parsed.data.activationKey, parsed.data.value);
      return reply.code(204).send();
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/executions/:id/events", (request, reply) => {
    const executionId = request.params.id;
    const lastEventId = Number(request.headers["last-event-id"] ?? 0);

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    for (const event of listRunEventsSince(db, executionId, lastEventId)) {
      writeEvent(reply.raw, event.seq, event.kind, event.payload);
    }

    const unsubscribe = hub.subscribe(executionId, (event) => {
      writeEvent(reply.raw, event.seq, event.kind, event.payload);
    });
    request.raw.on("close", unsubscribe);
  });
}

function writeEvent(res: ServerResponse, seq: number, kind: string, payload: unknown): void {
  res.write(`id: ${seq}\nevent: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`);
}

interface FlowVersionProvenance {
  flowVersion?: { id: string; version: number; label: string | null; flowId: string };
  /** Present only when the flow's current HEAD differs from the version this execution ran —
   *  PLAN-FLOW-VERSIONING.md §4.5: "flow has changed since this run (N nodes)." */
  changedSinceRun?: { semantic: boolean; nodesChanged: number; currentVersionId: string };
}

/** Which version an execution ran, by label when it has one, and whether the flow has moved on
 *  since — the honest surface for step mode's deliberate HEAD-following (§4.6) applied to a
 *  finished run's detail view too. */
function describeFlowVersionProvenance(db: Db, flowVersionId: string): FlowVersionProvenance {
  const version = getFlowVersionRow(db, flowVersionId);
  if (!version) return {};
  const flowVersion = { id: version.id, version: version.version, label: version.label, flowId: version.flowId };

  const currentHead = getFlow(db, version.flowId);
  if (!currentHead || currentHead.flowVersionId === version.id) return { flowVersion };

  const diff = diffGraphs(version.graph, currentHead.graph);
  const nodesChanged = diff.nodes.added.length + diff.nodes.removed.length + diff.nodes.changed.length;
  return {
    flowVersion,
    changedSinceRun: { semantic: isSemanticChange(diff), nodesChanged, currentVersionId: currentHead.flowVersionId },
  };
}
