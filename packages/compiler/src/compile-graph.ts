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

/** One router-branch condition that must hold for a node's statement to run. A node's `Scope`
 *  is the ordered list of `Guard`s from outermost to innermost — see `computeScopes`. */
interface Guard {
  routerId: string;
  branchTargetId: string;
  sourceHandle: string;
}
type Scope = readonly Guard[];

interface EmitCtx {
  nodesById: Map<string, FlowNode>;
  incoming: Map<string, Map<string, IncomingEdge>>;
  bodyByParent: Map<string, FlowNode>;
  routerBranches: Map<string, RouterBranch[]>;
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

  const routerBranches = new Map<string, RouterBranch[]>();
  for (const edge of outerGraph.edges) {
    if (nodesById.get(edge.source)?.type === "router") {
      const list = routerBranches.get(edge.source) ?? [];
      list.push({ sourceHandle: edge.sourceHandle ?? "output", targetId: edge.target });
      routerBranches.set(edge.source, list);
    }
  }

  const hasControlFlow = outerNodes.some((n) => n.type === "router" || n.type === "loop" || n.type === "map");

  const levels = topoLevels(outerGraph);
  const order = levels.flat();
  const scopes = hasControlFlow ? computeScopes(order, incoming, routerBranches) : new Map<string, Scope>();
  const isOptionalId = (id: string): boolean => (scopes.get(id)?.length ?? 0) > 0;

  const specEntries = graph.nodes
    .map((node) => {
      const data = schemaTable[node.type].parse(node.data) as Record<string, unknown>;
      return `  ${varName(node.id)}: ${JSON.stringify({ id: node.id, ...data })} as const,`;
    })
    .join("\n");

  const statements = hasControlFlow
    ? emitSequential(order, scopes, { nodesById, incoming, bodyByParent, routerBranches })
    : levels.map((level) => emitLevel(level, nodesById, incoming)).join("\n");

  const finishBindings = terminalNodeIds
    .map((id) => `${varName(id)}: ${accessorExpr(nodesById.get(id)!, varName(id), isOptionalId(id))}`)
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
): string {
  if (level.length === 1) {
    const nodeId = level[0]!;
    return `  const ${varName(nodeId)} = ${callExpr(nodeId, nodesById, incoming, () => false)};`;
  }
  const decls = level.map(varName).join(", ");
  const calls = level.map((nodeId) => `    ${callExpr(nodeId, nodesById, incoming, () => false)},`).join("\n");
  return `  const [${decls}] = await Promise.all([\n${calls}\n  ]);`;
}

function guardEquals(a: Guard, b: Guard): boolean {
  return a.routerId === b.routerId && a.branchTargetId === b.branchTargetId;
}

function scopeEquals(a: Scope, b: Scope): boolean {
  return a.length === b.length && a.every((g, i) => guardEquals(g, b[i]!));
}

/** The longest leading run of `Guard`s two scopes agree on — the scope of their closest common
 *  ancestor. Diverges to `[]` once two scopes disagree on any Guard, or once the shorter scope
 *  runs out (a node fed by both a conditional and an unconditional source lands at whichever
 *  ancestor scope is common to both — the conservative/safe placement in either case). */
function commonPrefix(a: Scope, b: Scope): Scope {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && guardEquals(a[i]!, b[i]!)) i++;
  return a.slice(0, i);
}

/**
 * Computes each node's `Scope` — the router-branch conditions that must hold for it to run —
 * via one forward pass over topological order. A node's scope is the closest-common-ancestor
 * (`commonPrefix`) of all its inputs' scopes, plus one more `Guard` if the node is itself a
 * direct router-branch target. This replaces the old one-hop `branchNodeIds` set: nesting
 * composes automatically (a router nested inside another router's branch gets that branch's
 * guard prepended to its own targets' scopes, with no separate "ancestor router" bookkeeping),
 * and a reconvergence node (e.g. Merge, fed by two sibling branches) naturally lands back at
 * the shared ancestor scope since `commonPrefix` diverges at the router that split them.
 *
 * Known, deliberately unhandled edge cases (see CLAUDE.md):
 * - A node fed only by mutually-exclusive branches of two *different* routers with no Merge in
 *   between lands at scope `[]` (unconditional) and reads both inputs optionally — correct as
 *   far as it goes, but the compiler has no `required`-port metadata to detect that such a node
 *   would actually run with `undefined` in a field it needs. Pre-existing gap, not new here.
 * - If a single router wires two different routes to the literal same downstream node,
 *   `branchGuard`'s last write wins, so that node's scope reflects only one of the two
 *   branches. Very unusual graph shape (redundant, since the router already encodes the
 *   choice); left unhandled.
 */
function computeScopes(
  order: string[],
  incoming: Map<string, Map<string, IncomingEdge>>,
  routerBranches: Map<string, RouterBranch[]>,
): Map<string, Scope> {
  const branchGuard = new Map<string, Guard>();
  for (const [routerId, branches] of routerBranches) {
    for (const b of branches) {
      branchGuard.set(b.targetId, { routerId, branchTargetId: b.targetId, sourceHandle: b.sourceHandle });
    }
  }

  const scopes = new Map<string, Scope>();
  for (const nodeId of order) {
    const edges = [...(incoming.get(nodeId)?.values() ?? [])];
    let scope: Scope = edges.length === 0 ? [] : edges.map((e) => scopes.get(e.source)!).reduce(commonPrefix);
    const guard = branchGuard.get(nodeId);
    if (guard) scope = [...scope, guard];
    scopes.set(nodeId, scope);
  }
  return scopes;
}

/**
 * Sequential (non-`Promise.all`) statement emission, used whenever the graph contains a
 * Router/Loop/Map. Every conditionally-scoped node (`scope.length > 0`) is `let`-hoisted up
 * front in one flat pass, decoupled from which router "owns" it — a per-router hoist (walking
 * only that router's own transitive descendants) would double-declare a node nested inside two
 * routers, once from each ancestor's hoist pass. `emitScope` then recursively emits each node
 * exactly once, inside nested `if`/`else if` blocks matching its computed `Scope`, to arbitrary
 * depth — this is what lets a chain of any length inside a branch, or a router nested inside
 * another router's branch, compile correctly (previously: only nodes exactly one hop from a
 * router were guarded at all; see CLAUDE.md).
 */
function emitSequential(order: string[], scopes: Map<string, Scope>, ctx: EmitCtx): string {
  const { nodesById } = ctx;
  const isOptional = (sourceId: string): boolean => (scopes.get(sourceId)?.length ?? 0) > 0;

  const lines: string[] = [];
  for (const nodeId of order) {
    if ((scopes.get(nodeId)?.length ?? 0) === 0) continue;
    const method = emitTable[nodesById.get(nodeId)!.type].runtimeMethod;
    lines.push(`  let ${varName(nodeId)}: Awaited<ReturnType<typeof rt.${method}>> | undefined;`);
  }
  lines.push(...emitScope([], order, scopes, ctx, isOptional, "  "));
  return lines.join("\n");
}

function emitScope(
  scopePrefix: Scope,
  order: string[],
  scopes: Map<string, Scope>,
  ctx: EmitCtx,
  isOptional: (sourceId: string) => boolean,
  indent: string,
): string[] {
  const { nodesById, incoming, bodyByParent, routerBranches } = ctx;
  const isHoisted = scopePrefix.length > 0;
  const lines: string[] = [];

  for (const nodeId of order) {
    if (!scopeEquals(scopes.get(nodeId) ?? [], scopePrefix)) continue; // handled by an ancestor/descendant call
    const node = nodesById.get(nodeId)!;

    if (node.type === "router") {
      lines.push(`${indent}${isHoisted ? "" : "const "}${varName(nodeId)} = ${callExpr(nodeId, nodesById, incoming, isOptional)};`);
      const branches = routerBranches.get(nodeId) ?? [];
      branches.forEach((b, i) => {
        const keyword = i === 0 ? "if" : "} else if";
        lines.push(`${indent}${keyword} (${varName(nodeId)}.route === ${JSON.stringify(b.sourceHandle)}) {`);
        const branchScope: Scope = [...scopePrefix, { routerId: nodeId, branchTargetId: b.targetId, sourceHandle: b.sourceHandle }];
        lines.push(...emitScope(branchScope, order, scopes, ctx, isOptional, indent + "  "));
      });
      if (branches.length > 0) lines.push(`${indent}}`);
      continue;
    }

    if (node.type === "loop" || node.type === "map") {
      const bodyNode = bodyByParent.get(nodeId);
      if (!bodyNode) throw new Error(`"${node.type}" node "${nodeId}" has no body node (a child with parentId set)`);
      lines.push(emitLoopOrMap(node, bodyNode, incoming, isOptional, indent, isHoisted));
      continue;
    }

    lines.push(`${indent}${isHoisted ? "" : "const "}${varName(nodeId)} = ${callExpr(nodeId, nodesById, incoming, isOptional)};`);
  }
  return lines;
}

function emitLoopOrMap(
  node: FlowNode,
  bodyNode: FlowNode,
  incoming: Map<string, Map<string, IncomingEdge>>,
  isOptional: (sourceId: string) => boolean,
  indent: string,
  isHoisted: boolean,
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
      return `${port}: ${accessorExpr(sourceNode, varName(edge.source), isOptional(edge.source), edge.sourceHandle)}`;
    })
    .join(", ");

  const combinator = node.type === "loop" ? "loop" : "map";
  const bodyParam = node.type === "loop" ? "acc, i" : "item, i";
  // Scoped id matches the interpreter's `activationKey(bodyNodeId, [{loop: nodeId, index}])` format,
  // so per-iteration events/responses line up identically between interpreted and compiled runs.
  const scopedIdExpr = "`" + bodyNode.id + "@" + node.id + ":${i}`";
  return `${indent}${isHoisted ? "" : "const "}${varName(node.id)} = await rt.${combinator}(N.${varName(node.id)}, { ${ownBindings} }, async (${bodyParam}) => {
${indent}  const bodyResult = await rt.${bodyMethod}({ ...N.${varName(bodyNode.id)}, id: ${scopedIdExpr}, contextNodeId: ${JSON.stringify(bodyNode.id)} }, { ${bodyBindings} });
${indent}  return bodyResult.output;
${indent}});`;
}

function callExpr(
  nodeId: string,
  nodesById: Map<string, FlowNode>,
  incoming: Map<string, Map<string, IncomingEdge>>,
  isOptional: (sourceId: string) => boolean,
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
      const optional = isOptional(edge.source);
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
