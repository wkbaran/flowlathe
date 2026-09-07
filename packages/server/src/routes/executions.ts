import type { ServerResponse } from "node:http";
import type { Scheduler, ToolRegistration } from "@flowlathe/core";
import {
  type Db,
  getExecution,
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

export function registerExecutionRoutes(app: FastifyInstance, deps: ExecutionRouteDeps): void {
  const { db, hub, scheduler, pluginToolsets, flowsDir } = deps;

  app.get<{ Params: { id: string }; Querystring: { branchId?: string } }>(
    "/api/executions/:id",
    async (request, reply) => {
      const execution = getExecution(db, request.params.id);
      if (!execution) return reply.code(404).send({ error: "execution not found" });
      return { execution, responses: listResponses(db, request.params.id, request.query.branchId) };
    },
  );

  app.get<{ Params: { id: string } }>("/api/executions/:id/branches", async (request, reply) => {
    const execution = getExecution(db, request.params.id);
    if (!execution) return reply.code(404).send({ error: "execution not found" });
    return listBranches(db, request.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { branchId: string } }>(
    "/api/executions/:id/snapshots",
    async (request, reply) => {
      if (!request.query.branchId) return reply.code(400).send({ error: "branchId query param is required" });
      return listSnapshotsForBranch(db, request.query.branchId);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { branchId: string } }>(
    "/api/executions/:id/state",
    async (request, reply) => {
      if (!request.query.branchId) return reply.code(400).send({ error: "branchId query param is required" });
      return getStateSnapshot(db, request.query.branchId);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { branchId: string } }>(
    "/api/executions/:id/state-lineage",
    async (request, reply) => {
      if (!request.query.branchId) return reply.code(400).send({ error: "branchId query param is required" });
      return listStateLineage(db, request.query.branchId);
    },
  );

  app.post<{ Params: { id: string } }>("/api/executions/:id/step", async (request, reply) => {
    const parsed = StepBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const execution = getExecution(db, request.params.id);
    if (!execution) return reply.code(404).send({ error: "execution not found" });
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
