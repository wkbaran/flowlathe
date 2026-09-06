import type { ServerResponse } from "node:http";
import { type Db, getExecution, listResponses, listRunEventsSince } from "@flowlathe/persistence";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExecutionHub } from "../execution-hub.js";

const ResumeBody = z.object({ activationKey: z.string().min(1), value: z.string() });

export function registerExecutionRoutes(app: FastifyInstance, db: Db, hub: ExecutionHub): void {
  app.get<{ Params: { id: string } }>("/api/executions/:id", async (request, reply) => {
    const execution = getExecution(db, request.params.id);
    if (!execution) return reply.code(404).send({ error: "execution not found" });
    return { execution, responses: listResponses(db, request.params.id) };
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
