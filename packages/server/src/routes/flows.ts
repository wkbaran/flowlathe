import type { ProviderConfig } from "@flowlathe/compiler";
import { compileGraph } from "@flowlathe/compiler";
import { emptyFlowGraph, parseFlowGraph, type Scheduler, type ToolRegistration } from "@flowlathe/core";
import { createFlow, getFlow, listFlows, listProviders, saveFlowVersion } from "@flowlathe/persistence";
import type { Db } from "@flowlathe/persistence";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExecutionHub } from "../execution-hub.js";
import { runFlow } from "../executor.js";
import { startStepExecution } from "../stepper.js";

const CreateFlowBody = z.object({ name: z.string().min(1) });
const SaveFlowBody = z.object({ graph: z.unknown() });

export interface FlowRouteDeps {
  db: Db;
  hub: ExecutionHub;
  scheduler: Scheduler;
  pluginToolsets?: ToolRegistration[] | undefined;
}

export function registerFlowRoutes(app: FastifyInstance, deps: FlowRouteDeps): void {
  const { db, hub, scheduler, pluginToolsets } = deps;

  app.get("/api/flows", async () => listFlows(db));

  app.post("/api/flows", async (request, reply) => {
    const parsed = CreateFlowBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const flow = createFlow(db, parsed.data.name, emptyFlowGraph());
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

  app.post<{ Params: { id: string } }>("/api/flows/:id/run", async (request, reply) => {
    const flow = getFlow(db, request.params.id);
    if (!flow) return reply.code(404).send({ error: "flow not found" });
    const { executionId, branchId } = runFlow({
      db,
      hub,
      scheduler,
      flowVersionId: flow.flowVersionId,
      graph: flow.graph,
      pluginToolsets,
    });
    return reply.code(202).send({ executionId, branchId });
  });

  app.post<{ Params: { id: string } }>("/api/flows/:id/step-start", async (request, reply) => {
    const flow = getFlow(db, request.params.id);
    if (!flow) return reply.code(404).send({ error: "flow not found" });
    return reply.code(201).send(startStepExecution(db, flow.flowVersionId));
  });

  app.get<{ Params: { id: string } }>("/api/flows/:id/export", async (request, reply) => {
    const flow = getFlow(db, request.params.id);
    if (!flow) return reply.code(404).send({ error: "flow not found" });
    try {
      const providers: Record<string, ProviderConfig> = Object.fromEntries(
        listProviders(db).map((p) => [p.id, { kind: p.kind, baseUrl: p.baseUrl ?? undefined }]),
      );
      const script = compileGraph(flow.graph, { providers });
      return { script };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
}
