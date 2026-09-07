import type { FlowGraph } from "@flowlathe/core";
import { canonicalEdgeId, dedupeEdgeIds } from "./edge-id.js";

/**
 * What `parse(print(g))` actually converges to for an arbitrary `FlowGraph` — not `g` itself,
 * in three specific respects: an edge with an omitted (default) `sourceHandle`/`targetHandle`
 * gets one filled in, an edge id that doesn't already follow `canonicalEdgeId`'s scheme gets
 * replaced (§3.5's edge-id note), and `edges` array order is not preserved at all — the printer
 * groups edges by source node in topological order (§3.3), not original array order, because
 * edge order carries no meaning anywhere else in the codebase. Everything else — node order
 * (topological, but stable-tied to original position, so an already-topological `nodes` array
 * survives untouched), `data`, `position`, `parentId`, `state` — round-trips exactly.
 *
 * Useful for comparing a graph that predates the DSL (e.g. one loaded from `flow_versions`)
 * against its round-tripped form, and for property tests that don't want to special-case those
 * fields themselves.
 */
export function normalizeForRoundTrip(graph: FlowGraph): FlowGraph {
  const withHandles = graph.edges.map((edge) => ({
    ...edge,
    sourceHandle: edge.sourceHandle ?? "output",
    targetHandle: edge.targetHandle ?? "input",
  }));
  const withIds = dedupeEdgeIds(
    withHandles.map((edge) => ({
      ...edge,
      id: canonicalEdgeId(edge.source, edge.sourceHandle, edge.target, edge.targetHandle),
    })),
  );
  const sorted = [...withIds].sort((a, b) => a.id.localeCompare(b.id));
  return { ...graph, edges: sorted };
}
