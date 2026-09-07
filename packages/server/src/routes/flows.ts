import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderConfig } from "@flowlathe/compiler";
import { compileGraph } from "@flowlathe/compiler";
import {
  diffGraphs,
  emptyFlowGraph,
  findMissingToolsets,
  isSemanticChange,
  parseFlowGraph,
  requiredToolsets,
  validateGraph,
  type FlowGraph,
  type FlowNode,
  type Scheduler,
  type ToolRegistration,
} from "@flowlathe/core";
import { DslError, parse } from "@flowlathe/dsl";
import { registry } from "@flowlathe/interpreter";
import {
  contentHashOf,
  createFlow,
  getFlow,
  getFlowVersionRow,
  labelFlowVersion,
  listFlowPins,
  listFlowVersions,
  listFlows,
  listProviders,
  saveFlowVersion,
  setFlowPin,
} from "@flowlathe/persistence";
import type { Db } from "@flowlathe/persistence";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExecutionHub } from "../execution-hub.js";
import { runFlow } from "../executor.js";
import { canonicalTextFor, loadFlowFile } from "../flow-store.js";
import type { FlowsHub } from "../flows-hub.js";
import { graphAtGitCommit, isGitWorkTree, listGitHistory } from "../git-history.js";
import { startStepExecution } from "../stepper.js";

const CreateFlowBody = z.object({ name: z.string().min(1) });
const SaveFlowBody = z.object({ graph: z.unknown(), ifMatch: z.string().optional(), label: z.string().optional(), message: z.string().optional() });
const ImportFlowBody = z.object({ text: z.string().min(1) });
const LabelVersionBody = z.object({ label: z.string().min(1), message: z.string().optional() });
const RestoreFlowBody = z.object({ versionId: z.string().min(1) });
const SetPinBody = z.object({ flowVersionId: z.string().min(1) });

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
   *  through, so an edited flow is always reflected on disk. `opts.label`/`opts.message` name this
   *  save as a milestone ("Save as version…" in the canvas); `opts.parentVersionId` overrides the
   *  recorded parent (restore — PLAN-FLOW-VERSIONING.md §3, §4.2). */
  function persistAndSync(id: string, name: string, graph: FlowGraph, opts?: { label?: string; message?: string; parentVersionId?: string; force?: boolean }) {
    const text = canonicalTextFor(name, graph);
    mkdirSync(flowsDir, { recursive: true });
    writeFileSync(join(flowsDir, `${id}.flow`), text);
    const saved = saveFlowVersion(db, id, graph, text, opts);
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

  /** Paste-to-import (PLAN-FLOW-DSL.md S4): a flow whose `flow "name" { ... }` header matches an
   *  existing flow's name is treated as a new version of it (same rationale as `flowlathe flows
   *  import`'s CLI counterpart); otherwise a new flow is created, with an id freshly slugified
   *  from the name — never the id of the flow the text was pasted from, since two independently
   *  slugified names can coincide only by writing the same name, which is exactly the "same flow"
   *  case being handled here already. */
  app.post("/api/flows/import", async (request, reply) => {
    const parsed = ImportFlowBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }
    let name: string;
    let graph: FlowGraph;
    try {
      ({ name, graph } = parse(parsed.data.text));
    } catch (err) {
      const message = err instanceof DslError ? err.message : (err as Error).message;
      return reply.code(400).send({ error: message });
    }
    const problems = validateGraph(graph, { portsOf });
    if (problems.length > 0) {
      return reply.code(400).send({ error: `invalid flow graph: ${problems.join("; ")}` });
    }

    const existing = listFlows(db).find((f) => f.name === name);
    if (existing) {
      return reply.code(200).send(persistAndSync(existing.id, name, graph));
    }
    const text = canonicalTextFor(name, graph);
    const flow = createFlow(db, name, graph, { sourceText: text });
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

    return persistAndSync(request.params.id, flow.name, graph, {
      ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
      ...(parsed.data.message !== undefined ? { message: parsed.data.message } : {}),
    });
  });

  app.get<{ Params: { id: string } }>("/api/flows/:id/versions", async (request, reply) => {
    const flow = getFlow(db, request.params.id);
    if (!flow) return reply.code(404).send({ error: "flow not found" });
    return listFlowVersions(db, request.params.id);
  });

  app.get<{ Params: { id: string; versionId: string } }>("/api/flows/:id/versions/:versionId", async (request, reply) => {
    const version = getFlowVersionRow(db, request.params.versionId);
    if (!version || version.flowId !== request.params.id) return reply.code(404).send({ error: "version not found" });
    return version;
  });

  app.post<{ Params: { id: string; versionId: string } }>("/api/flows/:id/versions/:versionId/label", async (request, reply) => {
    const parsed = LabelVersionBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const existing = getFlowVersionRow(db, request.params.versionId);
    if (!existing || existing.flowId !== request.params.id) return reply.code(404).send({ error: "version not found" });
    return labelFlowVersion(db, request.params.versionId, parsed.data.label, parsed.data.message);
  });

  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>("/api/flows/:id/diff", async (request, reply) => {
    const { from, to } = request.query;
    if (!from || !to) return reply.code(400).send({ error: "from and to query params are required" });
    const fromVersion = getFlowVersionRow(db, from);
    const toVersion = getFlowVersionRow(db, to);
    if (!fromVersion || fromVersion.flowId !== request.params.id) return reply.code(404).send({ error: `version not found: ${from}` });
    if (!toVersion || toVersion.flowId !== request.params.id) return reply.code(404).send({ error: `version not found: ${to}` });
    const diff = diffGraphs(fromVersion.graph, toVersion.graph);
    return { diff, isSemanticChange: isSemanticChange(diff) };
  });

  /** Creates a NEW head equal to an old version's graph — history is never rewritten
   *  (PLAN-FLOW-VERSIONING.md §4.5, design trap 2). `parentVersionId` is recorded as the restored
   *  version itself, not whatever was HEAD a moment before, so history reads as a tree: this new
   *  revision's real lineage is the old one it was restored from. */
  app.post<{ Params: { id: string } }>("/api/flows/:id/restore", async (request, reply) => {
    const parsed = RestoreFlowBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const flow = getFlow(db, request.params.id);
    if (!flow) return reply.code(404).send({ error: "flow not found" });
    const version = getFlowVersionRow(db, parsed.data.versionId);
    if (!version || version.flowId !== request.params.id) return reply.code(404).send({ error: "version not found" });
    return persistAndSync(request.params.id, flow.name, version.graph, { parentVersionId: version.id, force: true });
  });

  /** Generic named pointers (PLAN-FLOW-VERSIONING.md §3/§6) — a Discord trigger pins directly via
   *  `triggers.flowVersionId` instead (predates this table, already satisfies "never follow
   *  HEAD"); this is for channels with no dedicated row of their own, starting with `"default"`. */
  app.get<{ Params: { id: string } }>("/api/flows/:id/pins", async (request, reply) => {
    if (!getFlow(db, request.params.id)) return reply.code(404).send({ error: "flow not found" });
    return listFlowPins(db, request.params.id);
  });

  app.put<{ Params: { id: string; channel: string } }>("/api/flows/:id/pins/:channel", async (request, reply) => {
    const parsed = SetPinBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const version = getFlowVersionRow(db, parsed.data.flowVersionId);
    if (!version || version.flowId !== request.params.id) return reply.code(404).send({ error: "version not found" });
    return setFlowPin(db, request.params.id, request.params.channel, parsed.data.flowVersionId);
  });

  /** PLAN-FLOW-VERSIONING.md §5 (Layer 2): read-only, only when `flowsDir` is itself a git work
   *  tree — the version-history drawer's "git" tab. Never writes anything to the user's repo. */
  app.get<{ Params: { id: string } }>("/api/flows/:id/git-history", async (request, reply) => {
    if (!getFlow(db, request.params.id)) return reply.code(404).send({ error: "flow not found" });
    if (!isGitWorkTree(flowsDir)) return { available: false, commits: [] };
    return { available: true, commits: listGitHistory(flowsDir, request.params.id) };
  });

  /** `to` omitted compares a past commit against the flow's CURRENT graph (working state); given,
   *  compares two commits directly — either way, fed through the same `diffGraphs` every other
   *  diff view uses. */
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>(
    "/api/flows/:id/git-diff",
    async (request, reply) => {
      const flow = getFlow(db, request.params.id);
      if (!flow) return reply.code(404).send({ error: "flow not found" });
      const { from, to } = request.query;
      if (!from) return reply.code(400).send({ error: "from query param is required" });
      const fromGraph = graphAtGitCommit(flowsDir, request.params.id, from);
      if (!fromGraph) return reply.code(404).send({ error: `could not read flow at commit ${from}` });
      const toGraph = to ? graphAtGitCommit(flowsDir, request.params.id, to) : flow.graph;
      if (!toGraph) return reply.code(404).send({ error: `could not read flow at commit ${to}` });
      const diff = diffGraphs(fromGraph, toGraph);
      return { diff, isSemanticChange: isSemanticChange(diff) };
    },
  );

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
