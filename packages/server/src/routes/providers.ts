import {
  createModel,
  createProvider,
  type Db,
  deleteModel,
  deleteProvider,
  getProvider,
  listModels,
  listProviders,
  updateProvider,
} from "@flowlathe/persistence";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SchedulerRegistry } from "../scheduler-registry.js";

const ProviderKindSchema = z.enum(["mock", "ollama", "openai-compat"]);

const CreateProviderBody = z.object({
  name: z.string().min(1),
  kind: ProviderKindSchema,
  baseUrl: z.string().optional(),
  secret: z.string().optional(),
  maxParallel: z.number().int().positive().optional(),
  rpm: z.number().int().positive().optional(),
  tpm: z.number().int().positive().optional(),
  swapCostMs: z.number().int().nonnegative().optional(),
  residentModels: z.number().int().positive().optional(),
});

const UpdateProviderBody = CreateProviderBody.partial();

const CreateModelBody = z.object({
  modelName: z.string().min(1),
  contextWindow: z.number().int().positive().optional(),
  defaultsJson: z.unknown().optional(),
});

export interface ProviderRouteDeps {
  db: Db;
  credentialKey: Buffer;
  schedulerRegistry: SchedulerRegistry;
}

export function registerProviderRoutes(app: FastifyInstance, deps: ProviderRouteDeps): void {
  const { db, credentialKey, schedulerRegistry } = deps;

  app.get("/api/providers", async () => listProviders(db));

  app.post("/api/providers", async (request, reply) => {
    const parsed = CreateProviderBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return reply.code(201).send(createProvider(db, credentialKey, parsed.data));
  });

  app.put<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) => {
    const parsed = UpdateProviderBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (!getProvider(db, request.params.id)) return reply.code(404).send({ error: "provider not found" });
    const updated = updateProvider(db, credentialKey, request.params.id, parsed.data);
    schedulerRegistry.invalidate(request.params.id);
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/providers/:id", async (request, reply) => {
    if (!getProvider(db, request.params.id)) return reply.code(404).send({ error: "provider not found" });
    deleteProvider(db, request.params.id);
    schedulerRegistry.invalidate(request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>("/api/providers/:id/models", async (request) =>
    listModels(db, request.params.id),
  );

  app.post<{ Params: { id: string } }>("/api/providers/:id/models", async (request, reply) => {
    const provider = getProvider(db, request.params.id);
    if (!provider) return reply.code(404).send({ error: "provider not found" });
    const parsed = CreateModelBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    return reply.code(201).send(createModel(db, { providerId: request.params.id, ...parsed.data }));
  });

  app.delete<{ Params: { id: string } }>("/api/models/:id", async (request, reply) => {
    deleteModel(db, request.params.id);
    return reply.code(204).send();
  });

  app.get("/api/scheduler/stats", async () => schedulerRegistry.getStats());
}
