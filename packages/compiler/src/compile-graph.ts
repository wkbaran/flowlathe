import {
  requiredToolsets,
  terminalNodeIds,
  validateGraph,
  type FlowGraph,
  type FlowNode,
  type ToolRegistration,
} from "@flowlathe/core";
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
  /** The server's live plugin tool registrations, used only to look up each required toolset's
   *  `standalone` descriptor (if any) — see §4.4 of PLAN-INTEGRATIONS.md. Absent/empty means every
   *  required toolset is treated as server-only, matching the original (pre-`standalone`)
   *  behavior. */
  toolsets?: ToolRegistration[] | undefined;
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

/** One enclosing Loop/Map iteration, innermost last. Mirrors the interpreter's `ScopePath`
 *  (`@flowlathe/core`'s `activation.ts`), except `indexVar` names the *generated variable* that
 *  holds the iteration index at runtime rather than a concrete number. */
interface LoopFrame {
  loopId: string;
  indexVar: string;
}

/**
 * Everything needed to emit one **region** — the top-level graph (`ownerId: undefined`) or one
 * Loop/Map node's body (`ownerId: <that node's id>`) — see PLAN-SUBGRAPH-BODIES.md. `incoming` and
 * `routerBranches` are restricted to this region's own in-region edges; `nodesById` is the single
 * global node map (every node in the whole graph), since a node's *kind* is needed regardless of
 * which region references it (e.g. `accessorExpr` on an edge's source).
 */
interface RegionCtx {
  graph: FlowGraph;
  nodesById: Map<string, FlowNode>;
  ownerId: string | undefined;
  incoming: Map<string, Map<string, IncomingEdge>>;
  routerBranches: Map<string, RouterBranch[]>;
  order: string[];
  scopes: Map<string, Scope>;
  hasControlFlow: boolean;
  levels: string[][];
  /** The per-iteration value injected into this region's entry ports (a port with no in-region
   *  edge whose name matches). `undefined` for the top-level region. */
  injected: { port: string; expr: string } | undefined;
  /** Enclosing Loop/Map iterations, outermost first — `[]` for the top-level region. */
  loopStack: LoopFrame[];
  /** This region's one terminal node (required by `validateGraph`'s R5 for any body region).
   *  `undefined` for the top-level region, which may have several. */
  terminalId: string | undefined;
}

export function compileGraph(graph: FlowGraph, opts: CompileOptions): string {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  // Mirrors the interpreter's own validateGraph gate (run-graph.ts) — fail at export/compile time
  // rather than emitting a script that would crash on a node with an unbound port or a body with
  // no single terminal. `portsOf` uses raw `node.data` (not schema-parsed), matching every other
  // port lookup already in this file (`callExpr`'s `emitter.inputPorts(node.data)`).
  const portsOf = (n: FlowNode): string[] => emitTable[n.type].inputPorts(n.data);
  const problems = validateGraph(graph, { portsOf });
  if (problems.length > 0) {
    throw new Error(`invalid flow graph: ${problems.join("; ")}`);
  }

  const topCtx = buildRegionCtx(graph, nodesById, undefined, undefined, []);
  const statements = emitRegion(topCtx, "  ").join("\n");

  const topIds = new Set(topCtx.order);
  const hasOutgoingTop = new Set(
    graph.edges.filter((e) => topIds.has(e.source) && topIds.has(e.target)).map((e) => e.source),
  );
  const terminalIdsTop = [...topIds].filter((id) => !hasOutgoingTop.has(id));
  const isOptionalTop = (id: string): boolean => (topCtx.scopes.get(id)?.length ?? 0) > 0;

  const specEntries = graph.nodes
    .map((node) => {
      const data = schemaTable[node.type].parse(node.data) as Record<string, unknown>;
      return `  ${varName(node.id)}: ${JSON.stringify({ id: node.id, ...data })} as const,`;
    })
    .join("\n");

  const finishBindings = terminalIdsTop
    .map((id) => `${varName(id)}: ${accessorExpr(nodesById.get(id)!, varName(id), isOptionalTop(id))}`)
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

  // Partition this flow's required plugin toolsets into standalone-capable (the registration
  // itself says how to rebuild it from env alone — see ToolRegistration.standalone) and
  // server-only (Spotify's OAuth tokens, an MCP server's config file: nothing a standalone script
  // could reconstruct). Absent opts.toolsets (or a toolset with no matching registration) treats
  // every required toolset as server-only, matching this function's original, pre-`standalone`
  // behavior — see PLAN-INTEGRATIONS.md §4.4.
  const registrationsByToolset = new Map<string, ToolRegistration[]>();
  for (const reg of opts.toolsets ?? []) {
    registrationsByToolset.set(reg.toolset, [...(registrationsByToolset.get(reg.toolset) ?? []), reg]);
  }
  const unsupportedToolsets: string[] = [];
  const standaloneByModuleFactory = new Map<string, { module: string; factory: string; env: string[] }>();
  for (const toolset of requiredToolsets(graph)) {
    const standalone = (registrationsByToolset.get(toolset) ?? []).find((r) => r.standalone)?.standalone;
    if (standalone) {
      standaloneByModuleFactory.set(`${standalone.module}#${standalone.factory}`, standalone);
    } else {
      unsupportedToolsets.push(toolset);
    }
  }
  const standaloneImports = [...standaloneByModuleFactory.values()];
  const standaloneImportLines = standaloneImports
    .map((s) => `import { ${s.factory} } from ${JSON.stringify(s.module)};`)
    .join("\n");
  const standaloneToolsetCalls = standaloneImports.map((s) => `...${s.factory}()`).join(", ");
  const standaloneEnvVars = [...new Set(standaloneImports.flatMap((s) => s.env))];
  const unsupportedToolsetsLiteral = JSON.stringify(unsupportedToolsets);

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
${standaloneImportLines ? `${standaloneImportLines}\n` : ""}
const N = {
${specEntries}
} as const;

const STATE_DECLS = ${stateDeclsLiteral};

// Plugin toolsets with no standalone reconstruction (e.g. "spotify": its OAuth tokens live in
// this server's DB) aren't supported in exported scripts — a compiled script has no server, DB,
// or credential store to source them from. A flow using one still exports (the script is a
// faithful record of the graph), but refuses to run rather than crashing confusingly on a node
// that expects tools no registry here will ever provide. Toolsets with a standalone
// reconstruction (e.g. SearXNG, Firecrawl — see the imports above, driven entirely by env vars${
    standaloneEnvVars.length > 0 ? `: ${standaloneEnvVars.join(", ")}` : ""
  }) are wired into the tool registry below instead.
const REQUIRED_PLUGIN_TOOLSETS = ${unsupportedToolsetsLiteral};

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
      tools: createToolRegistry([...stateToolset(state)${standaloneToolsetCalls ? `, ${standaloneToolsetCalls}` : ""}]),
      net: { fetch: globalThis.fetch },
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

/** Builds the emission context for one region: the top level (`ownerId: undefined`) or one
 *  Loop/Map node's body (`ownerId`: that node's id). */
function buildRegionCtx(
  graph: FlowGraph,
  nodesById: Map<string, FlowNode>,
  ownerId: string | undefined,
  injected: { port: string; expr: string } | undefined,
  loopStack: LoopFrame[],
): RegionCtx {
  const regionIds = new Set(graph.nodes.filter((n) => (n.parentId ?? undefined) === ownerId).map((n) => n.id));
  const regionNodes = graph.nodes.filter((n) => regionIds.has(n.id));
  const regionEdges = graph.edges.filter((e) => regionIds.has(e.source) && regionIds.has(e.target));
  const incoming = buildIncoming(regionEdges);

  const routerBranches = new Map<string, RouterBranch[]>();
  for (const edge of regionEdges) {
    if (nodesById.get(edge.source)?.type === "router") {
      const list = routerBranches.get(edge.source) ?? [];
      list.push({ sourceHandle: edge.sourceHandle ?? "output", targetId: edge.target });
      routerBranches.set(edge.source, list);
    }
  }

  const hasControlFlow = regionNodes.some((n) => n.type === "router" || n.type === "loop" || n.type === "map");
  const levels = topoLevels({ nodes: regionNodes, edges: regionEdges, state: [] });
  const order = levels.flat();
  const scopes = hasControlFlow ? computeScopes(order, incoming, routerBranches) : new Map<string, Scope>();
  const terminalId = ownerId !== undefined ? terminalNodeIds(graph, ownerId)[0] : undefined;

  return { graph, nodesById, ownerId, incoming, routerBranches, order, scopes, hasControlFlow, levels, injected, loopStack, terminalId };
}

/** A region's terminal node compiles to the fixed local name `bodyResult` rather than the usual
 *  `n_<id>` — it's what a Loop/Map body's arrow function returns, and giving it a stable name
 *  independent of the node's id is what lets a single-node body (the historical, still-common
 *  case) and a multi-node body compile through the exact same machinery. Every other node in a
 *  region uses the ordinary `n_<id>` convention. */
function emitName(nodeId: string, ctx: RegionCtx): string {
  return nodeId === ctx.terminalId ? "bodyResult" : varName(nodeId);
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
 * Called once per region (see `buildRegionCtx`) — `order`/`incoming`/`routerBranches` are all
 * already restricted to that region, so scope analysis for a Loop/Map body is entirely
 * independent of its enclosing region's scopes.
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
 * Emits one region's statements at `indent`. When the region has no Router/Loop/Map at all, uses
 * the flat `Promise.all`-per-level fast path (unchanged since before subgraph bodies). Otherwise,
 * every conditionally-scoped node is `let`-hoisted first — for the top-level region this lands in
 * `main()`'s preamble; for a Loop/Map body (called from `emitLoopOrMap`) this lands as the first
 * lines *inside* the arrow function, so a body's hoisted variables don't persist across
 * iterations (a router branch not taken on iteration 2 must not silently read iteration 1's
 * value — see CLAUDE.md and PLAN-SUBGRAPH-BODIES.md section 5). `emitScope` then recursively
 * emits each node exactly once, inside nested `if`/`else if` blocks matching its computed
 * `Scope`, to arbitrary depth, decoupled from which router "owns" it.
 */
function emitRegion(ctx: RegionCtx, indent: string): string[] {
  const isOptional = (id: string): boolean => (ctx.scopes.get(id)?.length ?? 0) > 0;
  if (!ctx.hasControlFlow) {
    return ctx.levels.map((level) => emitLevel(level, ctx, isOptional, indent));
  }

  const lines: string[] = [];
  for (const nodeId of ctx.order) {
    if ((ctx.scopes.get(nodeId)?.length ?? 0) === 0) continue;
    const method = emitTable[ctx.nodesById.get(nodeId)!.type].runtimeMethod;
    lines.push(`${indent}let ${emitName(nodeId, ctx)}: Awaited<ReturnType<typeof rt.${method}>> | undefined;`);
  }
  lines.push(...emitScope([], ctx, isOptional, indent));
  return lines;
}

function emitLevel(level: string[], ctx: RegionCtx, isOptional: (id: string) => boolean, indent: string): string {
  if (level.length === 1) {
    const nodeId = level[0]!;
    return `${indent}const ${emitName(nodeId, ctx)} = ${callExpr(nodeId, ctx, isOptional)};`;
  }
  const decls = level.map((id) => emitName(id, ctx)).join(", ");
  const calls = level.map((nodeId) => `${indent}  ${callExpr(nodeId, ctx, isOptional)},`).join("\n");
  return `${indent}const [${decls}] = await Promise.all([\n${calls}\n${indent}]);`;
}

function emitScope(scopePrefix: Scope, ctx: RegionCtx, isOptional: (id: string) => boolean, indent: string): string[] {
  const isHoisted = scopePrefix.length > 0;
  const lines: string[] = [];

  for (const nodeId of ctx.order) {
    if (!scopeEquals(ctx.scopes.get(nodeId) ?? [], scopePrefix)) continue; // handled by an ancestor/descendant call
    const node = ctx.nodesById.get(nodeId)!;
    const name = emitName(nodeId, ctx);

    if (node.type === "router") {
      lines.push(`${indent}${isHoisted ? "" : "const "}${name} = ${callExpr(nodeId, ctx, isOptional)};`);
      const branches = ctx.routerBranches.get(nodeId) ?? [];
      branches.forEach((b, i) => {
        const keyword = i === 0 ? "if" : "} else if";
        lines.push(`${indent}${keyword} (${name}.route === ${JSON.stringify(b.sourceHandle)}) {`);
        const branchScope: Scope = [...scopePrefix, { routerId: nodeId, branchTargetId: b.targetId, sourceHandle: b.sourceHandle }];
        lines.push(...emitScope(branchScope, ctx, isOptional, indent + "  "));
      });
      if (branches.length > 0) lines.push(`${indent}}`);
      continue;
    }

    if (node.type === "loop" || node.type === "map") {
      lines.push(emitLoopOrMap(node, ctx, isOptional, indent, isHoisted));
      continue;
    }

    lines.push(`${indent}${isHoisted ? "" : "const "}${name} = ${callExpr(nodeId, ctx, isOptional)};`);
  }
  return lines;
}

/**
 * Emits a Loop/Map node as an `rt.loop`/`rt.map` call whose body arrow function is itself a
 * full recursively-emitted region (`emitRegion(childCtx, ...)`) — the body can be an arbitrary
 * multi-node subgraph, not just a single node (see PLAN-SUBGRAPH-BODIES.md). The body's one
 * terminal node (guaranteed by `validateGraph`'s R5) is always named `bodyResult` (`emitName`)
 * and is what the arrow function returns, via `accessorExpr` so the right field is read
 * regardless of the terminal's node kind. If the terminal itself is conditionally scoped (e.g.
 * it sits directly inside an untaken router branch, with no Merge to always resolve it), it may
 * be `undefined` at the end of an iteration — guarded with an explicit throw whose message
 * mirrors the interpreter's identical guard in `GraphEngine.regionResult`.
 */
function emitLoopOrMap(node: FlowNode, ctx: RegionCtx, isOptional: (id: string) => boolean, indent: string, isHoisted: boolean): string {
  const combinator = node.type === "loop" ? "loop" : "map";
  // Depth-correct index variable naming: "i" at depth 0 (matches pre-existing compiled output
  // for a top-level loop/map, so existing fixtures don't churn), "i1", "i2", ... deeper — see
  // PLAN-SUBGRAPH-BODIES.md section 4.2 item 4.
  const indexVar = ctx.loopStack.length === 0 ? "i" : `i${ctx.loopStack.length}`;
  const bodyParam = node.type === "loop" ? `acc, ${indexVar}` : `item, ${indexVar}`;
  const injectedPort =
    node.type === "loop" ? (node.data as { accPortName: string }).accPortName : (node.data as { itemPortName: string }).itemPortName;
  const injectedExpr = node.type === "loop" ? "acc" : "item";

  const ownPorts: string[] = emitTable[node.type].inputPorts(node.data);
  const ownBindings = ownPorts.map((port) => bindPort(node.id, port, ctx, isOptional)).join(", ");

  const childLoopStack = [...ctx.loopStack, { loopId: node.id, indexVar }];
  const childCtx = buildRegionCtx(ctx.graph, ctx.nodesById, node.id, { port: injectedPort, expr: injectedExpr }, childLoopStack);
  const bodyIndent = indent + "  ";
  const bodyLines = emitRegion(childCtx, bodyIndent);

  const terminalId = childCtx.terminalId!;
  const terminalNode = ctx.nodesById.get(terminalId)!;
  const terminalName = emitName(terminalId, childCtx);
  const terminalOptional = (childCtx.scopes.get(terminalId)?.length ?? 0) > 0;
  // Once the guard below has thrown on `undefined`, the terminal is known-defined — so the
  // return itself never needs `?.`, guarded or not (matching PLAN-SUBGRAPH-BODIES.md's sample:
  // the guard and a plain, non-optional accessor).
  const terminalAccessor = accessorExpr(terminalNode, terminalName, false);
  const returnLines = terminalOptional
    ? [
        `${bodyIndent}if (${terminalName} === undefined) throw new Error(${JSON.stringify(
          `${node.type} body's terminal node "${terminalId}" was skipped — every path through the body must reach it`,
        )});`,
        `${bodyIndent}return ${terminalAccessor};`,
      ]
    : [`${bodyIndent}return ${terminalAccessor};`];

  // Like any other body node, the loop/map node's OWN spec needs the scoped-id/contextNodeId
  // treatment (via specExpr) whenever IT is itself nested inside an enclosing body — its own
  // `node_started`/`node_finished` events must carry the same scoped id the interpreter's
  // `parseSpec` would give it in that position (see run-graph.ts's `dispatchLoopOrMap`).
  const name = emitName(node.id, ctx);
  const header = `${indent}${isHoisted ? "" : "const "}${name} = await rt.${combinator}(${specExpr(node.id, ctx)}, { ${ownBindings} }, async (${bodyParam}) => {`;
  const footer = `${indent}});`;
  return [header, ...bodyLines, ...returnLines, footer].join("\n");
}

/** One port's binding expression: the accessor into its in-region source edge, or — for a body
 *  entry port with no in-region edge whose name matches this region's `injected` port — the
 *  injected value's own expression (`acc`/`item`). Every other unbound port was already caught
 *  by `validateGraph`'s R7 before compilation got here, so the throw below is an invariant
 *  check, not a reachable user-facing error path. Shared by `callExpr` (an ordinary node's
 *  bindings) and `emitLoopOrMap` (a loop/map node's OWN bindings, from its enclosing region —
 *  which matters when the loop/map node is itself a body entry point one level up, as in a
 *  Map-of-Loop nesting). */
function bindPort(nodeId: string, port: string, ctx: RegionCtx, isOptional: (id: string) => boolean): string {
  const edge = ctx.incoming.get(nodeId)?.get(port);
  if (edge) {
    const sourceNode = ctx.nodesById.get(edge.source)!;
    return `${port}: ${accessorExpr(sourceNode, varName(edge.source), isOptional(edge.source), edge.sourceHandle)}`;
  }
  if (ctx.injected && ctx.injected.port === port) return `${port}: ${ctx.injected.expr}`;
  throw new Error(`node "${nodeId}" has no incoming edge bound to input "${port}"`);
}

function callExpr(nodeId: string, ctx: RegionCtx, isOptional: (id: string) => boolean): string {
  const node = ctx.nodesById.get(nodeId);
  if (!node) throw new Error(`unknown node "${nodeId}"`);
  const emitter = emitTable[node.type];
  const ports: string[] = emitter.inputPorts(node.data);
  const bindings = ports.map((port) => bindPort(nodeId, port, ctx, isOptional)).join(", ");
  return `await rt.${emitter.runtimeMethod}(${specExpr(nodeId, ctx)}, { ${bindings} })`;
}

/** A node's spec expression: the plain `N.<var>` table entry at the top level, or — inside any
 *  Loop/Map body, at any nesting depth — that entry spread with an overridden scoped `id` and a
 *  `contextNodeId` pinned to the node's own (unscoped) id, so a repeatedly-dispatched body node's
 *  conversation memory accumulates across iterations instead of resetting each time (CLAUDE.md). */
function specExpr(nodeId: string, ctx: RegionCtx): string {
  if (ctx.loopStack.length === 0) return `N.${varName(nodeId)}`;
  return `{ ...N.${varName(nodeId)}, id: ${scopedIdExpr(nodeId, ctx.loopStack)}, contextNodeId: ${JSON.stringify(nodeId)} }`;
}

/** Mirrors the interpreter's `activationKey(nodeId, scopePath)` format
 *  (`@flowlathe/core`'s `activation.ts`) byte-for-byte, but built from the generated index
 *  variables' names rather than concrete numbers — e.g. for a node nested two loops deep this
 *  produces the template literal `` `x@outer:${i}/inner:${i1}` ``, which renders at runtime to
 *  exactly what `activationKey("x", [{loop:"outer",index:0},{loop:"inner",index:2}])` would
 *  return for those indices. Both sides must move together if this format ever changes — see
 *  CLAUDE.md's "manual-parity risk" note. */
function scopedIdExpr(nodeId: string, loopStack: LoopFrame[]): string {
  const parts = loopStack.map((f) => `${f.loopId}:\${${f.indexVar}}`).join("/");
  return "`" + nodeId + "@" + parts + "`";
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
    // `search`/`fetch` are read via an explicit `sourceHandle` ("results"/"content") whenever a
    // downstream node wires to them; this case only matters for the *terminal, no-reading-edge*
    // fallback (`finishBindings`, which always calls this with the default sourceHandle
    // "output") — every other node kind's single output port happens to be named "output", so
    // this fallback needs a kind-specific override here, same as router/loop/map above.
    case "search":
      return sourceHandle === "output" ? `${varRef}${dot}results` : `${varRef}${dot}${sourceHandle}`;
    case "fetch":
      return sourceHandle === "output" ? `${varRef}${dot}content` : `${varRef}${dot}${sourceHandle}`;
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
