import fastifyStatic from "@fastify/static";
import type { Scheduler } from "@flowlathe/core";
import type { Db } from "@flowlathe/persistence";
import Fastify, { type FastifyInstance } from "fastify";
import { ExecutionHub } from "./execution-hub.js";
import { registerExecutionRoutes } from "./routes/executions.js";
import { registerFlowRoutes } from "./routes/flows.js";

export interface BuildAppOptions {
  db: Db;
  scheduler: Scheduler;
  staticRoot?: string;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  const hub = new ExecutionHub();

  registerFlowRoutes(app, { db: opts.db, hub, scheduler: opts.scheduler });
  registerExecutionRoutes(app, opts.db, hub);

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
