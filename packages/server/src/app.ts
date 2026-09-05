import fastifyStatic from "@fastify/static";
import type { Db } from "@flowlathe/persistence";
import Fastify, { type FastifyInstance } from "fastify";
import { ExecutionHub } from "./execution-hub.js";
import { registerExecutionRoutes } from "./routes/executions.js";
import { registerFlowRoutes } from "./routes/flows.js";
import { registerProviderRoutes } from "./routes/providers.js";
import type { SchedulerRegistry } from "./scheduler-registry.js";

export interface BuildAppOptions {
  db: Db;
  credentialKey: Buffer;
  schedulerRegistry: SchedulerRegistry;
  staticRoot?: string;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const hub = new ExecutionHub();

  registerFlowRoutes(app, { db: opts.db, hub, scheduler: opts.schedulerRegistry });
  registerExecutionRoutes(app, opts.db, hub);
  registerProviderRoutes(app, {
    db: opts.db,
    credentialKey: opts.credentialKey,
    schedulerRegistry: opts.schedulerRegistry,
  });

  if (opts.staticRoot) {
    const staticRoot = opts.staticRoot;
    app.register(fastifyStatic, { root: staticRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith("/api/")) {
        return reply.code(404).send({ error: "not found" });
      }
      return reply.sendFile("index.html", staticRoot);
    });
  }

  return app;
}
