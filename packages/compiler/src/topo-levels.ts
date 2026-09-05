import type { FlowGraph } from "@flowlathe/core";

/**
 * Groups nodes into levels: each level's nodes have no dependency on each other and can be
 * emitted as a single `Promise.all`. A level only becomes ready once every node in every
 * earlier level is done, mirroring the interpreter's readiness rule for a plain DAG.
 */
export function topoLevels(graph: FlowGraph): string[][] {
  const incomingCount = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of graph.nodes) {
    incomingCount.set(node.id, 0);
    dependents.set(node.id, []);
  }
  for (const edge of graph.edges) {
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    dependents.get(edge.source)?.push(edge.target);
  }

  const levels: string[][] = [];
  let frontier = graph.nodes.filter((n) => incomingCount.get(n.id) === 0).map((n) => n.id);
  const visited = new Set<string>();

  while (frontier.length > 0) {
    levels.push(frontier);
    for (const id of frontier) visited.add(id);
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of dependents.get(id) ?? []) {
        const remaining = (incomingCount.get(dep) ?? 0) - 1;
        incomingCount.set(dep, remaining);
        if (remaining === 0) next.push(dep);
      }
    }
    frontier = next;
  }

  if (visited.size !== graph.nodes.length) {
    const stuck = graph.nodes.map((n) => n.id).filter((id) => !visited.has(id));
    throw new Error(`cycle detected or missing upstream node among: ${stuck.join(", ")}`);
  }

  return levels;
}
