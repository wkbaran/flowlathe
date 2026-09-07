import type { ToolRegistration } from "@flowlathe/core";
import { createTrigger, deleteTrigger, getFlow, listTriggers, type Db } from "@flowlathe/persistence";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { TriggerRegistry, validateTriggerGraph } from "../triggers/registry.js";

const CreateTriggerBody = z.object({
  flowId: z.string().min(1),
  source: z.literal("discord"),
  channelIds: z.array(z.string().min(1)).min(1),
});

export interface TriggerRouteDeps {
  db: Db;
  registry: TriggerRegistry;
  pluginToolsets?: ToolRegistration[] | undefined;
}

export function registerTriggerRoutes(app: FastifyInstance, deps: TriggerRouteDeps): void {
  const { db, registry, pluginToolsets } = deps;

  app.get("/api/triggers", async () =>
    listTriggers(db).map((t) => ({ ...t, active: registry.isActive(t.id) })),
  );

  app.post("/api/triggers", async (request, reply) => {
    const parsed = CreateTriggerBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });

    const flow = getFlow(db, parsed.data.flowId);
    if (!flow) return reply.code(404).send({ error: "flow not found" });

    // Pins to the flow's version as of right now — an explicit action, never re-resolved to
    // HEAD later (PLAN-INTEGRATIONS.md §7.3: "editing a flow on the canvas must not silently
    // change what a live Discord bot does").
    const problems = validateTriggerGraph(flow.graph, pluginToolsets ?? []);
    if (problems.length > 0) {
      return reply.code(409).send({ error: problems.map((p) => p.message).join("; "), problems });
    }

    const trigger = createTrigger(db, {
      flowId: flow.id,
      flowVersionId: flow.flowVersionId,
      source: "discord",
      config: { channelIds: parsed.data.channelIds },
    });

    try {
      await registry.start(trigger);
    } catch (err) {
      deleteTrigger(db, trigger.id);
      return reply.code(409).send({ error: (err as Error).message });
    }

    return reply.code(201).send(trigger);
  });

  app.delete<{ Params: { id: string } }>("/api/triggers/:id", async (request, reply) => {
    await registry.stop(request.params.id);
    deleteTrigger(db, request.params.id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/triggers/:id/repin", async (request, reply) => {
    const existing = listTriggers(db).find((t) => t.id === request.params.id);
    if (!existing) return reply.code(404).send({ error: "trigger not found" });
    const flow = getFlow(db, existing.flowId);
    if (!flow) return reply.code(404).send({ error: "flow not found" });

    const problems = validateTriggerGraph(flow.graph, pluginToolsets ?? []);
    if (problems.length > 0) {
      return reply.code(409).send({ error: problems.map((p) => p.message).join("; "), problems });
    }

    await registry.stop(existing.id);
    deleteTrigger(db, existing.id);
    const trigger = createTrigger(db, {
      flowId: flow.id,
      flowVersionId: flow.flowVersionId,
      source: existing.source,
      config: existing.configJson,
    });
    await registry.start(trigger);
    return trigger;
  });
}
