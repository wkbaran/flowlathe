import { parseFlowGraph } from "@flowlathe/core";
import { createFlow, getFlow, listFlows, saveFlowVersion } from "@flowlathe/persistence";
import type { Db } from "@flowlathe/persistence";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

const CreateFlowBody = z.object({ name: z.string().min(1) });
const SaveFlowBody = z.object({ graph: z.unknown() });

export function registerFlowRoutes(app: FastifyInstance, db: Db): void {
  app.get("/api/flows", async () => listFlows(db));

  app.post("/api/flows", async (request, reply) => {
    const parsed = CreateFlowBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const flow = createFlow(db, parsed.data.name, { nodes: [], edges: [] });
    return reply.code(201).send(flow);
  });

  app.get<{ Params: { id: string } }>("/api/flows/:id", async (request, reply) => {
    const flow = getFlow(db, request.params.id);
    if (!flow) return reply.code(404).send({ error: "flow not found" });
    return flow;
  });

  app.put<{ Params: { id: string } }>("/api/flows/:id", async (request, reply) => {
    const parsed = SaveFlowBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    if (!getFlow(db, request.params.id)) {
      return reply.code(404).send({ error: "flow not found" });
    }
    let graph;
    try {
      graph = parseFlowGraph(parsed.data.graph);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    return saveFlowVersion(db, request.params.id, graph);
  });
}
