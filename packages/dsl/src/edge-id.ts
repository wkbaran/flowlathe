import type { FlowEdge } from "@flowlathe/core";

/** Edge ids are not written in the surface syntax at all (`a.port -> b.port` carries no id
 *  token) — they exist purely so `FlowEdgeSchema` has something unique to key on downstream.
 *  Deriving them deterministically from the endpoints means a hand-written `.flow` file behaves
 *  identically every time it's parsed, and lets the printer stay silent about an implementation
 *  detail nothing else in the DSL needs to see. */
export function canonicalEdgeId(source: string, sourceHandle: string, target: string, targetHandle: string): string {
  return `${source}.${sourceHandle}->${target}.${targetHandle}`;
}

/** Two edges with identical (source, sourceHandle, target, targetHandle) collide under
 *  `canonicalEdgeId` — an unusual, redundant graph shape, but not one the parser should reject.
 *  Suffix the duplicates deterministically instead, mirroring the canvas's node-name
 *  slugification convention (`extract`, `extract-2`). */
export function dedupeEdgeIds(edges: FlowEdge[]): FlowEdge[] {
  const seen = new Map<string, number>();
  return edges.map((edge) => {
    const count = seen.get(edge.id) ?? 0;
    seen.set(edge.id, count + 1);
    return count === 0 ? edge : { ...edge, id: `${edge.id}#${count + 1}` };
  });
}
