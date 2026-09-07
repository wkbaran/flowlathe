import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderConfig } from "@flowlathe/compiler";
import { compileGraph } from "@flowlathe/compiler";
import {
  emptyFlowGraph,
  findMissingToolsets,
  parseFlowGraph,
  requiredToolsets,
  validateGraph,
  type FlowGraph,
  type FlowNode,
  type Scheduler,
  type ToolRegistration,
} from "@flowlathe/core";
import { registry } from "@flowlathe/interpreter";
import { contentHashOf, createFlow, getFlow, listFlows, listProviders, saveFlowVersion } from "@flowlathe/persistence";
import type { Db } from "@flowlathe/persistence";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExecutionHub } from "../execution-hub.js";
import { runFlow } from "../executor.js";
import { canonicalTextFor, loadFlowFile } from "../flow-store.js";
import type { FlowsHub } from "../flows-hub.js";
import { startStepExecution } from "../stepper.js";

const CreateFlowBody = z.object({ name: z.string().min(1) });
const SaveFlowBody = z.object({ graph: z.unknown(), ifMatch: z.string().optional() });

export interface FlowRouteDeps {
  db: Db;
  hub: ExecutionHub;
  scheduler: Scheduler;
  pluginToolsets?: ToolRegistration[] | undefined;
  flowsDir: string;
  flowsHub: FlowsHub;
}

export function registerFlowRoutes(app: FastifyInstance, deps: FlowRouteDeps): void {
  const { db, hub, scheduler, pluginToolsets, flowsDir, flowsHub } = deps;

  /** Writes `<flowsDir>/<id>.flow` and snapshots a `flow_versions` row for it (content-hash
   *  deduped by `saveFlowVersion`) — the one place every SAVE (not create — see `POST /api/
   *  flows`, which needs the id `createFlow` just minted before it can name the file) goes
   *  through, so an edited flow is always reflected on disk. */
  function persistAndSync(id: string, name: string, graph: FlowGraph) {
    const text = canonicalTextFor(name, graph);
    mkdirSync(flowsDir, { recursive: true });
    writeFileSync(join(flowsDir, `${id}.flow`), text);
    const saved = saveFlowVersion(db, id, graph, text);
    flowsHub.publish({ slug: id });
    return saved;
  }

  app.get("/api/flows", async () => listFlows(db));

  app.post("/api/flows", async (request, reply) => {
    const parsed = CreateFlowBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    const graph = emptyFlowGraph();
    const text = canonicalTextFor(parsed.data.name, graph);
    const flow = createFlow(db, parsed.data.name, graph, { sourceText: text });
    mkdirSync(flowsDir, { recursive: true });
    writeFileSync(join(flowsDir, `${flow.id}.flow`), text);
    flowsHub.publish({ slug: flow.id });
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
    const flow = getFlow(db, request.params.id);
    if (!flow) {
      return reply.code(404).send({ error: "flow not found" });
    }
    let graph;
    try {
      graph = parseFlowGraph(parsed.data.graph);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }

    // ifMatch is optional so an older caller that never sends it (no conflict awareness) keeps
    // working exactly as before — it just always wins, same as pre-S3 last-write-wins semantics.
    // A caller that DOES send it gets real protection against an external edit to the file.
    if (parsed.data.ifMatch !== undefined) {
      const onDisk = loadFlowFile(flowsDir, request.params.id);
      const currentHash = onDisk ? contentHashOf(onDisk.sourceText) : undefined;
      if (currentHash !== undefined && currentHash !== parsed.data.ifMatch) {
        return reply.code(409).send({ error: "flow file changed on disk since it was loaded", currentText: onDisk!.sourceText });
      }
    }

    return persistAndSync(request.params.id, flow.name, graph);
  });

  app.post<{ Params: { id: string } }>("/api/flows/:id/run", async (request, reply) => {
    const flow = getFlow(db, request.params.id);
    if (!flow) return reply.code(404).send({ error: "flow not found" });
    const problems = validateGraph(flow.graph, { portsOf });
    if (problems.length > 0) {
      return reply.code(409).send({ error: `invalid flow graph: ${problems.join("; ")}`, problems });
    }
    const missing = findMissingToolsets(pluginToolsets ?? [], requiredToolsets(flow.graph));
    if (missing.length > 0) {
      return reply.code(409).send({ error: dependencyErrorMessage(missing), missing });
    }
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
    const problems = validateGraph(flow.graph, { portsOf });
    if (problems.length > 0) {
      return reply.code(409).send({ error: `invalid flow graph: ${problems.join("; ")}`, problems });
    }
    const missing = findMissingToolsets(pluginToolsets ?? [], requiredToolsets(flow.graph));
    if (missing.length > 0) {
      return reply.code(409).send({ error: dependencyErrorMessage(missing), missing });
    }
    return reply.code(201).send(startStepExecution(db, flow.flowVersionId));
  });

  app.get<{ Params: { id: string } }>("/api/flows/:id/export", async (request, reply) => {
    const flow = getFlow(db, request.params.id);
    if (!flow) return reply.code(404).send({ error: "flow not found" });
    try {
      const providers: Record<string, ProviderConfig> = Object.fromEntries(
        listProviders(db).map((p) => [p.id, { kind: p.kind, baseUrl: p.baseUrl ?? undefined }]),
      );
      const script = compileGraph(flow.graph, { providers, toolsets: pluginToolsets });
      return { script };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/flows/:id/source", async (request, reply) => {
    const flow = getFlow(db, request.params.id);
    if (!flow) return reply.code(404).send({ error: "flow not found" });
    return { name: flow.name, source: canonicalTextFor(flow.name, flow.graph) };
  });

  /** S4's live DSL panel and external-change reload prompt subscribe here; wired up server-side
   *  now so it's ready for that slice without any further server change. */
  app.get("/api/flows/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const unsubscribe = flowsHub.subscribe((event) => {
      reply.raw.write(`event: invalidated\ndata: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on("close", unsubscribe);
  });
}

function dependencyErrorMessage(missing: { toolset: string; reason: string }[]): string {
  return `workflow is missing required plugin(s): ${missing.map((m) => `${m.toolset} (${m.reason})`).join("; ")}`;
}

/** Same rationale as the plugin-toolset gate above: the interpreter's own `validateGraph` call
 *  (in `GraphEngine`'s constructor) would still create an execution row that immediately flips
 *  to "failed" via the `run_failed` fast-fail path, rather than refusing the request outright —
 *  so both `/run` and `/step-start` check first. Mirrors `run-graph.ts`'s own `portsOf`. */
function portsOf(node: FlowNode): string[] {
  const data = registry[node.type].schema.parse(node.data) as Record<string, unknown>;
  return registry[node.type].inputPorts({ id: node.id, ...data }).map((p) => p.name);
}
