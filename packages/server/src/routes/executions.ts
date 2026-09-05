import type { ServerResponse } from "node:http";
import { type Db, getExecution, listResponses, listRunEventsSince } from "@flowlathe/persistence";
import type { FastifyInstance } from "fastify";
import type { ExecutionHub } from "../execution-hub.js";

export function registerExecutionRoutes(app: FastifyInstance, db: Db, hub: ExecutionHub): void {
  app.get<{ Params: { id: string } }>("/api/executions/:id", async (request, reply) => {
    const execution = getExecution(db, request.params.id);
    if (!execution) return reply.code(404).send({ error: "execution not found" });
    return { execution, responses: listResponses(db, request.params.id) };
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
