import type { FlowEdge, FlowGraph, FlowNode } from "./graph.js";

/** ownerId is undefined for the top-level region — every other region is keyed by the id of the
 *  Loop/Map node that owns it (its body). */
export interface Region {
  ownerId: string | undefined;
  nodeIds: string[];
  /** Edge ids whose source AND target are both in this region. */
  edgeIds: string[];
}

const TOP_LEVEL_KEY = "";

function regionKey(ownerId: string | undefined): string {
  return ownerId ?? TOP_LEVEL_KEY;
}

/** Every region in the graph, keyed by ownerId (`""` for the top level). A node with a
 *  `parentId` that doesn't actually name an existing node still gets its own (likely invalid,
 *  see R1) region so every node in the graph ends up in exactly one region. */
export function regions(graph: FlowGraph): Map<string, Region> {
  const byOwner = new Map<string, Region>();
  const ownerOf = new Map<string, string | undefined>();

  for (const node of graph.nodes) {
    const ownerId = node.parentId;
    ownerOf.set(node.id, ownerId);
    const key = regionKey(ownerId);
    let region = byOwner.get(key);
    if (!region) {
      region = { ownerId, nodeIds: [], edgeIds: [] };
      byOwner.set(key, region);
    }
    region.nodeIds.push(node.id);
  }
  // Ensure a top-level region always exists, even for an empty graph.
  if (!byOwner.has(TOP_LEVEL_KEY)) byOwner.set(TOP_LEVEL_KEY, { ownerId: undefined, nodeIds: [], edgeIds: [] });

  for (const edge of graph.edges) {
    const sourceOwner = ownerOf.get(edge.source);
    const targetOwner = ownerOf.get(edge.target);
    if (sourceOwner === undefined && targetOwner === undefined) {
      byOwner.get(TOP_LEVEL_KEY)!.edgeIds.push(edge.id);
    } else if (sourceOwner !== undefined && sourceOwner === targetOwner) {
      byOwner.get(regionKey(sourceOwner))!.edgeIds.push(edge.id);
    }
    // Boundary-crossing edges (exactly one endpoint in a body, or endpoints in two different
    // bodies) belong to no region — R4 flags them as an error.
  }

  return byOwner;
}

/** Body nodes (region `ownerId`) with no outgoing in-region edge. Exactly one is required for
 *  the region to be runnable — see R5. */
export function terminalNodeIds(graph: FlowGraph, ownerId: string): string[] {
  const region = regions(graph).get(regionKey(ownerId));
  if (!region) return [];
  const edgesById = new Map(graph.edges.map((e) => [e.id, e]));
  const hasOutgoing = new Set<string>();
  for (const edgeId of region.edgeIds) {
    hasOutgoing.add(edgesById.get(edgeId)!.source);
  }
  return region.nodeIds.filter((id) => !hasOutgoing.has(id));
}

export interface ValidationOptions {
  /** Declared input port names for a node. Omit to skip the port-level rules (R6, R7). */
  portsOf?: (node: FlowNode) => string[];
}

/** Human-readable problems, empty when the graph is runnable. Order is stable (R1 before R2
 *  before ... before R7), each rule's own problems in graph order. */
export function validateGraph(graph: FlowGraph, opts: ValidationOptions = {}): string[] {
  const problems: string[] = [];
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));

  // R1: every parentId names an existing node.
  for (const node of graph.nodes) {
    if (node.parentId !== undefined && !nodesById.has(node.parentId)) {
      problems.push(`node "${node.id}" has parentId "${node.parentId}", which does not name any node in the graph`);
    }
  }

  // R2: a parentId target must be of kind loop or map.
  for (const node of graph.nodes) {
    if (node.parentId === undefined) continue;
    const parent = nodesById.get(node.parentId);
    if (parent && parent.type !== "loop" && parent.type !== "map") {
      problems.push(`node "${node.id}" has parentId "${node.parentId}", but "${node.parentId}" is a "${parent.type}" node, not a loop/map`);
    }
  }

  const allRegions = regions(graph);

  // R3: every loop/map node has >=1 body node.
  const loopMapNodes = graph.nodes.filter((n) => n.type === "loop" || n.type === "map");
  for (const node of loopMapNodes) {
    const region = allRegions.get(node.id);
    if (!region || region.nodeIds.length === 0) {
      problems.push(`"${node.type}" node "${node.id}" has no body node (expected a child with parentId set to it)`);
    }
  }

  // R4: no edge crosses a body boundary, in either direction.
  const ownerOf = new Map(graph.nodes.map((n) => [n.id, n.parentId]));
  for (const edge of graph.edges) {
    const sourceOwner = ownerOf.get(edge.source);
    const targetOwner = ownerOf.get(edge.target);
    if (sourceOwner === targetOwner) continue;
    if (sourceOwner === undefined) {
      problems.push(
        `edge "${edge.id}" (${edge.source} -> ${edge.target}) crosses into a Loop/Map body from outside it — ` +
          `an outer node cannot feed a body node directly; use flow State (read_state/write_state) to pass a ` +
          `loop-invariant value into a body instead`,
      );
    } else if (targetOwner === undefined) {
      problems.push(
        `edge "${edge.id}" (${edge.source} -> ${edge.target}) crosses out of a Loop/Map body to an outer node — ` +
          `a body's value can't be consumed outside the loop/map directly; use flow State ` +
          `(read_state/write_state) to pass a value out of a body instead`,
      );
    } else {
      problems.push(
        `edge "${edge.id}" (${edge.source} -> ${edge.target}) crosses between two different Loop/Map bodies — ` +
          `use flow State (read_state/write_state) to pass a value between bodies instead`,
      );
    }
  }

  // R5: each region is acyclic, and has exactly one terminal node.
  for (const region of allRegions.values()) {
    const cycleNodes = findCycleNodes(region, graph.edges);
    if (cycleNodes.length > 0) {
      const label = region.ownerId === undefined ? "top-level graph" : `body of "${region.ownerId}"`;
      problems.push(`${label} contains a cycle among: ${cycleNodes.join(", ")}`);
      continue; // terminal-node analysis on a cyclic region isn't meaningful
    }
    if (region.ownerId === undefined) continue; // the top level has no single "terminal" requirement
    const terminals = terminalNodeIds(graph, region.ownerId);
    const label = `body of "${region.ownerId}"`;
    if (terminals.length === 0) {
      problems.push(`${label} has no terminal node (every node has an outgoing edge — this can only happen with a cycle)`);
    } else if (terminals.length > 1) {
      problems.push(
        `${label} has more than one terminal node (${terminals.join(", ")}) — a loop/map body must produce exactly ` +
          `one value per iteration; join them with a Merge node`,
      );
    }
  }

  const portsOf = opts.portsOf;
  if (portsOf) {
    // R6: each body region has >=1 entry node declaring the injected port.
    for (const node of loopMapNodes) {
      const injectedPort = injectedPortName(node);
      if (!injectedPort) continue;
      const region = allRegions.get(node.id);
      if (!region) continue; // already reported by R3
      const hasEntry = region.nodeIds.some((id) => portsOf(nodesById.get(id)!).includes(injectedPort));
      if (!hasEntry) {
        problems.push(
          `body of "${node.id}" has no node declaring input port "${injectedPort}" — a ${node.type} body needs at ` +
            `least one node that receives the injected per-iteration value`,
        );
      }
    }

    // R7: every declared input port of every node has an incoming in-region edge, except a body
    // entry node's injected port.
    const inRegionTargetPorts = new Map<string, Set<string>>(); // nodeId -> set of targetHandle
    for (const edge of graph.edges) {
      if (ownerOf.get(edge.source) !== ownerOf.get(edge.target)) continue; // boundary-crossing, R4 already flags it
      const port = edge.targetHandle ?? "input";
      const set = inRegionTargetPorts.get(edge.target) ?? new Set<string>();
      set.add(port);
      inRegionTargetPorts.set(edge.target, set);
    }
    const stateNames = new Set(graph.state.map((d) => d.name));
    for (const node of graph.nodes) {
      const owner = node.parentId;
      const ownerNode = owner !== undefined ? nodesById.get(owner) : undefined;
      const injectedPort = ownerNode ? injectedPortName(ownerNode) : undefined;
      const declaredPorts = portsOf(node);
      const wired = inRegionTargetPorts.get(node.id) ?? new Set<string>();
      for (const port of declaredPorts) {
        if (wired.has(port)) continue;
        if (injectedPort && port === injectedPort) continue; // the injected exception
        // PLAN-STATE-FILES.md L8/L9: a Prompt node's template variable with no wired edge, whose
        // name matches a declared state entry, is an ambient binding — not a port that needs an
        // edge. Scoped to Prompt nodes only; Loop/Map's own template ports get no such exception.
        if (node.type === "prompt" && stateNames.has(port)) continue;
        problems.push(`node "${node.id}" declares input port "${port}" with no incoming edge`);
      }
    }
  }

  // R8 (PLAN-STATE-FILES.md): a type:"file" state decl must carry filePath/fileMode, and its
  // merge rule must be one file operations actually supports. `StateDeclSchema`'s own
  // `superRefine` already enforces this for every caller that goes through `parseFlowGraph`, but
  // a `.flow` file synced straight off disk (`flow-store.ts`'s `loadFlowFile`/`syncFlowFile`) or
  // pasted via `/api/flows/import` is parsed by `@flowlathe/dsl` directly and never re-validated
  // through that schema — without this rule, a malformed decl would reach `createStateStore` at
  // first run instead of failing clearly here, at every `validateGraph` call site (the
  // interpreter's `GraphEngine` constructor, the compiler, and the flow routes alike).
  for (const decl of graph.state) {
    if (decl.type !== "file") continue;
    if (!decl.filePath) problems.push(`state entry "${decl.name}" has type "file" but no filePath`);
    if (!decl.fileMode) problems.push(`state entry "${decl.name}" has type "file" but no fileMode`);
    if (decl.merge !== "replace" && decl.merge !== "append") {
      problems.push(`state entry "${decl.name}" has type "file" but merge "${decl.merge}" — file entries only support "replace"/"append"`);
    }
  }

  return problems;
}

function injectedPortName(loopOrMapNode: FlowNode): string | undefined {
  const data = loopOrMapNode.data as Record<string, unknown>;
  const name = loopOrMapNode.type === "loop" ? data["accPortName"] : data["itemPortName"];
  return typeof name === "string" && name.length > 0 ? name : undefined;
}

/** Nodes involved in a cycle within `region`, via edges restricted to `edgeIds` — plain DFS
 *  cycle detection (Kahn's-algorithm leftovers), returned in a stable (sorted) order. */
function findCycleNodes(region: Region, allEdges: FlowEdge[]): string[] {
  const edgesById = new Map(allEdges.map((e) => [e.id, e]));
  const nodeSet = new Set(region.nodeIds);
  const dependents = new Map<string, string[]>();
  const remainingDeps = new Map<string, number>();
  for (const id of region.nodeIds) {
    dependents.set(id, []);
    remainingDeps.set(id, 0);
  }
  for (const edgeId of region.edgeIds) {
    const edge = edgesById.get(edgeId)!;
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) continue;
    dependents.get(edge.source)!.push(edge.target);
    remainingDeps.set(edge.target, (remainingDeps.get(edge.target) ?? 0) + 1);
  }

  let frontier = region.nodeIds.filter((id) => remainingDeps.get(id) === 0);
  const visited = new Set<string>();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      visited.add(id);
      for (const dep of dependents.get(id) ?? []) {
        const remaining = (remainingDeps.get(dep) ?? 0) - 1;
        remainingDeps.set(dep, remaining);
        if (remaining === 0) next.push(dep);
      }
    }
    frontier = next;
  }

  return region.nodeIds.filter((id) => !visited.has(id)).sort();
}
