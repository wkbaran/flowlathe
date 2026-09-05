import fastifyStatic from "@fastify/static";
import type { Db } from "@flowlathe/persistence";
import Fastify, { type FastifyInstance } from "fastify";
import { registerFlowRoutes } from "./routes/flows.js";

export interface BuildAppOptions {
  db: Db;
  staticRoot?: string;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  registerFlowRoutes(app, opts.db);

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
