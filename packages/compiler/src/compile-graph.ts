import { requiredToolsets, type FlowGraph, type FlowNode } from "@flowlathe/core";
import { emitTable, schemaTable } from "./emit-table.js";
import { topoLevels } from "./topo-levels.js";

export type ProviderKind = "mock" | "ollama" | "openai-compat";

export interface ProviderConfig {
  kind: ProviderKind;
  /** Not secret — safe to embed literally. Ignored for "mock". */
  baseUrl?: string | undefined;
}

export interface CompileOptions {
  /** providerId -> how the generated script should construct that provider's adapter. */
  providers: Record<string, ProviderConfig>;
}

interface IncomingEdge {
  source: string;
  sourceHandle: string;
}

interface RouterBranch {
  sourceHandle: string;
  targetId: string;
}

export function compileGraph(graph: FlowGraph, opts: CompileOptions): string {
  const outerNodes = graph.nodes.filter((n) => !n.parentId);
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const bodyByParent = new Map<string, FlowNode>();
  for (const n of graph.nodes) {
    if (n.parentId) bodyByParent.set(n.parentId, n);
  }

  const outerIds = new Set(outerNodes.map((n) => n.id));
  const outerGraph: FlowGraph = {
    nodes: outerNodes,
    edges: graph.edges.filter((e) => outerIds.has(e.source) && outerIds.has(e.target)),
    state: graph.state,
  };
  const incoming = buildIncoming(outerGraph.edges);
  const hasOutgoing = new Set(outerGraph.edges.map((e) => e.source));
  const terminalNodeIds = outerNodes.map((n) => n.id).filter((id) => !hasOutgoing.has(id));

  const branchNodeIds = new Set<string>();
  const routerBranches = new Map<string, RouterBranch[]>();
  for (const edge of outerGraph.edges) {
    if (nodesById.get(edge.source)?.type === "router") {
      branchNodeIds.add(edge.target);
      const list = routerBranches.get(edge.source) ?? [];
      list.push({ sourceHandle: edge.sourceHandle ?? "output", targetId: edge.target });
      routerBranches.set(edge.source, list);
    }
  }

  const hasControlFlow = outerNodes.some((n) => n.type === "router" || n.type === "loop" || n.type === "map");

  const specEntries = graph.nodes
    .map((node) => {
      const data = schemaTable[node.type].parse(node.data) as Record<string, unknown>;
      return `  ${varName(node.id)}: ${JSON.stringify({ id: node.id, ...data })} as const,`;
    })
    .join("\n");

  const statements = hasControlFlow
    ? emitSequential({ outerGraph, nodesById, incoming, bodyByParent, branchNodeIds, routerBranches })
    : topoLevels(outerGraph)
        .map((level) => emitLevel(level, nodesById, incoming, branchNodeIds))
        .join("\n");

  const finishBindings = terminalNodeIds
    .map((id) => `${varName(id)}: ${accessorExpr(nodesById.get(id)!, varName(id), branchNodeIds.has(id))}`)
    .join(", ");

  const usedProviderIds = [...new Set(graph.nodes.map((n) => n.data["providerId"] as string))].filter(
    (id) => id in opts.providers,
  );
  const providerEntries = usedProviderIds
    .map((id) => `  ${JSON.stringify(id)}: { adapter: ${adapterCtor(id, opts.providers[id]!)}, maxParallel: 4 },`)
    .join("\n");

  const usedKinds = new Set(usedProviderIds.map((id) => opts.providers[id]!.kind));
  const adapterImports = [
    usedKinds.has("mock") && "MockProviderAdapter",
    usedKinds.has("ollama") && "OllamaProviderAdapter",
    usedKinds.has("openai-compat") && "OpenAiCompatAdapter",
  ].filter(Boolean);

  const stateDeclsLiteral = JSON.stringify(graph.state);
  const requiredPluginToolsetsLiteral = JSON.stringify(requiredToolsets(graph));

  return `import type { RunEvent } from "@flowlathe/core";
import {
  createContextStore,
  createLlmConfigStore,
  createRun,
  createStateStore,
  createSuspendRegistry,
  createToolRegistry,
  InMemoryBlobStore,
  stateToolset,
} from "@flowlathe/runtime";
import { SimpleScheduler${adapterImports.length ? `, ${adapterImports.join(", ")}` : ""} } from "@flowlathe/providers";

const N = {
${specEntries}
} as const;

const STATE_DECLS = ${stateDeclsLiteral};

// Plugin toolsets (e.g. "spotify") aren't supported in exported scripts yet — a compiled script
// has no server, DB, or credential store to source a plugin's OAuth/config from. A flow using one
// still exports (the script is a faithful record of the graph), but refuses to run rather than
// crashing confusingly on a node that expects tools no registry here will ever provide.
const REQUIRED_PLUGIN_TOOLSETS = ${requiredPluginToolsetsLiteral};

async function main() {
  if (REQUIRED_PLUGIN_TOOLSETS.length > 0) {
    console.error(
      \`this flow requires plugin toolset(s) not supported in exported scripts: \${REQUIRED_PLUGIN_TOOLSETS.join(", ")}\`,
    );
    process.exitCode = 1;
    return;
  }

  const scheduler = new SimpleScheduler({
${providerEntries}
  });
  const emit = (event: RunEvent): void => console.log(JSON.stringify(event));
  const state = createStateStore(emit, { decls: STATE_DECLS });
  const rt = createRun({
    host: {
      scheduler,
      blobs: new InMemoryBlobStore(),
      emit,
      clock: { now: () => Date.now() },
      state,
      llmConfig: createLlmConfigStore(),
      context: createContextStore(),
      tools: createToolRegistry(stateToolset(state)),
      ...createSuspendRegistry(),
    },
  });

${statements}

  rt.finish({ ${finishBindings} });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
`;
}

function emitLevel(
  level: string[],
  nodesById: Map<string, FlowNode>,
  incoming: Map<string, Map<string, IncomingEdge>>,
  branchNodeIds: Set<string>,
): string {
  if (level.length === 1) {
    const nodeId = level[0]!;
    return `  const ${varName(nodeId)} = ${callExpr(nodeId, nodesById, incoming, branchNodeIds)};`;
  }
  const decls = level.map(varName).join(", ");
  const calls = level.map((nodeId) => `    ${callExpr(nodeId, nodesById, incoming, branchNodeIds)},`).join("\n");
  return `  const [${decls}] = await Promise.all([\n${calls}\n  ]);`;
}

interface SequentialCtx {
  outerGraph: FlowGraph;
  nodesById: Map<string, FlowNode>;
  incoming: Map<string, Map<string, IncomingEdge>>;
  bodyByParent: Map<string, FlowNode>;
  branchNodeIds: Set<string>;
  routerBranches: Map<string, RouterBranch[]>;
}

/**
 * Sequential (non-`Promise.all`) statement emission, used whenever the graph contains a
 * Router/Loop/Map. v1 scope: a router's branches are exactly one node deep before converging —
 * deeper chains inside a branch aren't specially guarded (see CLAUDE.md).
 */
function emitSequential(ctx: SequentialCtx): string {
  const { nodesById, incoming, bodyByParent, branchNodeIds, routerBranches } = ctx;
  const order = topoLevels(ctx.outerGraph).flat();
  const lines: string[] = [];

  for (const nodeId of order) {
    if (branchNodeIds.has(nodeId)) continue; // emitted inline by its router, below
    const node = nodesById.get(nodeId)!;

    if (node.type === "router") {
      const branches = routerBranches.get(nodeId) ?? [];
      lines.push(`  const ${varName(nodeId)} = ${callExpr(nodeId, nodesById, incoming, branchNodeIds)};`);
      for (const b of branches) {
        const method = emitTable[nodesById.get(b.targetId)!.type].runtimeMethod;
        lines.push(`  let ${varName(b.targetId)}: Awaited<ReturnType<typeof rt.${method}>> | undefined;`);
      }
      branches.forEach((b, i) => {
        const keyword = i === 0 ? "if" : "} else if";
        lines.push(`  ${keyword} (${varName(nodeId)}.route === ${JSON.stringify(b.sourceHandle)}) {`);
        lines.push(`    ${varName(b.targetId)} = ${callExpr(b.targetId, nodesById, incoming, branchNodeIds)};`);
      });
      if (branches.length > 0) lines.push("  }");
      continue;
    }

    if (node.type === "loop" || node.type === "map") {
      const bodyNode = bodyByParent.get(nodeId);
      if (!bodyNode) throw new Error(`"${node.type}" node "${nodeId}" has no body node (a child with parentId set)`);
      lines.push(emitLoopOrMap(node, bodyNode, incoming, branchNodeIds));
      continue;
    }

    lines.push(`  const ${varName(nodeId)} = ${callExpr(nodeId, nodesById, incoming, branchNodeIds)};`);
  }
  return lines.join("\n");
}

function emitLoopOrMap(
  node: FlowNode,
  bodyNode: FlowNode,
  incoming: Map<string, Map<string, IncomingEdge>>,
  branchNodeIds: Set<string>,
): string {
  const bodyEmitter = emitTable[bodyNode.type];
  const bodyMethod = bodyEmitter.runtimeMethod;
  const bodyPorts: string[] = bodyEmitter.inputPorts(bodyNode.data);
  const injectedPort =
    node.type === "loop" ? (node.data["accPortName"] as string) : (node.data["itemPortName"] as string);
  const bodyBindings = bodyPorts
    .map((port) => (port === injectedPort ? `${port}: ${node.type === "loop" ? "acc" : "item"}` : `${port}: ""`))
    .join(", ");

  const ownPorts: string[] = emitTable[node.type].inputPorts(node.data);
  const ownBindings = ownPorts
    .map((port) => {
      const edge = incoming.get(node.id)?.get(port);
      if (!edge) throw new Error(`node "${node.id}" has no incoming edge bound to input "${port}"`);
      const sourceNode = { id: edge.source, type: "prompt" } as FlowNode; // kind only matters for accessor; init/items templates read plain values
      return `${port}: ${accessorExpr(sourceNode, varName(edge.source), branchNodeIds.has(edge.source), edge.sourceHandle)}`;
    })
    .join(", ");

  const combinator = node.type === "loop" ? "loop" : "map";
  const bodyParam = node.type === "loop" ? "acc, i" : "item, i";
  // Scoped id matches the interpreter's `activationKey(bodyNodeId, [{loop: nodeId, index}])` format,
  // so per-iteration events/responses line up identically between interpreted and compiled runs.
  const scopedIdExpr = "`" + bodyNode.id + "@" + node.id + ":${i}`";
  return `  const ${varName(node.id)} = await rt.${combinator}(N.${varName(node.id)}, { ${ownBindings} }, async (${bodyParam}) => {
    const bodyResult = await rt.${bodyMethod}({ ...N.${varName(bodyNode.id)}, id: ${scopedIdExpr}, contextNodeId: ${JSON.stringify(bodyNode.id)} }, { ${bodyBindings} });
    return bodyResult.output;
  });`;
}

function callExpr(
  nodeId: string,
  nodesById: Map<string, FlowNode>,
  incoming: Map<string, Map<string, IncomingEdge>>,
  branchNodeIds: Set<string>,
): string {
  const node = nodesById.get(nodeId);
  if (!node) throw new Error(`unknown node "${nodeId}"`);
  const emitter = emitTable[node.type];
  const ports: string[] = emitter.inputPorts(node.data);
  const bindings = ports
    .map((port) => {
      const edge = incoming.get(nodeId)?.get(port);
      if (!edge) throw new Error(`node "${nodeId}" has no incoming edge bound to input "${port}"`);
      const sourceNode = nodesById.get(edge.source)!;
      const optional = branchNodeIds.has(edge.source);
      return `${port}: ${accessorExpr(sourceNode, varName(edge.source), optional, edge.sourceHandle)}`;
    })
    .join(", ");
  return `await rt.${emitter.runtimeMethod}(N.${varName(nodeId)}, { ${bindings} })`;
}

/** `sourceHandle` selects which field of the source node's result to read — defaults to
 *  `"output"`, the conventional single-output-port name every existing node kind uses. A node
 *  with more than one output port (e.g. ContextTransform's `output`/`context`) relies on this. */
function accessorExpr(sourceNode: FlowNode, varRef: string, optional: boolean, sourceHandle = "output"): string {
  const dot = optional ? "?." : ".";
  switch (sourceNode.type) {
    case "loop":
      return varRef;
    case "map":
      return `JSON.stringify(${varRef})`;
    case "router":
      return `${varRef}${dot}passthrough`;
    default:
      return `${varRef}${dot}${sourceHandle}`;
  }
}

function buildIncoming(edges: FlowGraph["edges"]): Map<string, Map<string, IncomingEdge>> {
  const incoming = new Map<string, Map<string, IncomingEdge>>();
  for (const edge of edges) {
    let byPort = incoming.get(edge.target);
    if (!byPort) {
      byPort = new Map();
      incoming.set(edge.target, byPort);
    }
    byPort.set(edge.targetHandle ?? "input", { source: edge.source, sourceHandle: edge.sourceHandle ?? "output" });
  }
  return incoming;
}

function adapterCtor(providerId: string, config: ProviderConfig): string {
  if (config.kind === "mock") return "new MockProviderAdapter()";
  if (config.kind === "ollama") {
    const fallback = config.baseUrl ?? "http://127.0.0.1:11434";
    return `new OllamaProviderAdapter({ baseUrl: process.env["OLLAMA_BASE_URL"] ?? ${JSON.stringify(fallback)} })`;
  }
  const envVar = `FLOWLATHE_APIKEY_${providerId.replace(/[^a-zA-Z0-9_]/g, "_").toUpperCase()}`;
  return `new OpenAiCompatAdapter({ baseUrl: ${JSON.stringify(config.baseUrl ?? "")}, apiKey: process.env[${JSON.stringify(envVar)}] })`;
}

function varName(nodeId: string): string {
  return `n_${nodeId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}
