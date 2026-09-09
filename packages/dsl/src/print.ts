import { regions, type FlowEdge, type FlowNode, type Region, type StateDecl } from "@flowlathe/core";
import { reindentBlockString } from "./dedent.js";
import type { FlowFile } from "./types.js";

const INDENT = "  ";

export function print(file: FlowFile): string {
  const { name, graph, comments } = file;
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgesById = new Map(graph.edges.map((e) => [e.id, e]));
  const regionMap = regions(graph);

  const lines: string[] = [`flow ${printStringLiteral(name)} {`];

  const stateLines = graph.state.flatMap((decl) => printStateDecl(decl, INDENT, comments));
  if (stateLines.length > 0) lines.push(...stateLines);

  const topLevel = regionMap.get("")!;
  const orderedTopIds = topoOrder(topLevel.nodeIds, topLevel.edgeIds, edgesById);

  if (orderedTopIds.length > 0) {
    if (stateLines.length > 0) lines.push("");
    orderedTopIds.forEach((id, idx) => {
      if (idx > 0) lines.push("");
      lines.push(...printNode(nodesById.get(id)!, INDENT, regionMap, nodesById, edgesById, comments));
    });
  }

  const topEdges = topLevel.edgeIds.map((id) => edgesById.get(id)!);
  const edgeLines = printEdgesGroupedBySource(topEdges, orderedTopIds, INDENT, comments);
  if (edgeLines.length > 0) {
    if (stateLines.length > 0 || orderedTopIds.length > 0) lines.push("");
    lines.push(...edgeLines);
  }

  lines.push("}");
  return lines.join("\n") + "\n";
}

function printNode(
  node: FlowNode,
  indent: string,
  regionMap: Map<string, Region>,
  nodesById: Map<string, FlowNode>,
  edgesById: Map<string, FlowEdge>,
  comments: Record<string, string>,
): string[] {
  const out: string[] = [];
  const comment = comments["node:" + node.id];
  if (comment) out.push(...printComment(comment, indent));

  out.push(`${indent}node ${node.id}: ${node.type} @(${formatNumber(node.position.x)}, ${formatNumber(node.position.y)}) {`);
  const propIndent = indent + INDENT;
  for (const [key, value] of Object.entries(node.data)) {
    out.push(...printProperty(key, value, propIndent));
  }

  if (node.type === "loop" || node.type === "map") {
    const region = regionMap.get(node.id);
    out.push(`${propIndent}body {`);
    const bodyIndent = propIndent + INDENT;
    if (region && region.nodeIds.length > 0) {
      const ordered = topoOrder(region.nodeIds, region.edgeIds, edgesById);
      ordered.forEach((id, idx) => {
        if (idx > 0) out.push("");
        out.push(...printNode(nodesById.get(id)!, bodyIndent, regionMap, nodesById, edgesById, comments));
      });
      const bodyEdges = region.edgeIds.map((id) => edgesById.get(id)!);
      const bodyEdgeLines = printEdgesGroupedBySource(bodyEdges, ordered, bodyIndent, comments);
      if (bodyEdgeLines.length > 0) {
        if (ordered.length > 0) out.push("");
        out.push(...bodyEdgeLines);
      }
    }
    out.push(`${propIndent}}`);
  }

  out.push(`${indent}}`);
  return out;
}

function printStateDecl(decl: StateDecl, indent: string, comments: Record<string, string>): string[] {
  const out: string[] = [];
  const comment = comments["state:" + decl.name];
  if (comment) out.push(...printComment(comment, indent));
  let line = `${indent}state ${decl.name}: ${decl.type} merge=${decl.merge}`;
  if (decl.initial !== undefined) line += ` initial=${printValue(decl.initial)}`;
  // PLAN-STATE-FILES.md: only meaningful for type "file", but printed whenever present so a
  // round-trip through parse/print never silently drops them.
  if (decl.filePath !== undefined) line += ` filePath=${printStringLiteral(decl.filePath)}`;
  if (decl.fileMode !== undefined) line += ` fileMode=${decl.fileMode}`;
  if (decl.versioned !== undefined) line += ` versioned=${decl.versioned ? "true" : "false"}`;
  out.push(line);
  return out;
}

function printEdgesGroupedBySource(
  edges: FlowEdge[],
  orderedNodeIds: string[],
  indent: string,
  comments: Record<string, string>,
): string[] {
  const bySource = new Map<string, FlowEdge[]>();
  for (const edge of edges) {
    const list = bySource.get(edge.source) ?? [];
    list.push(edge);
    bySource.set(edge.source, list);
  }
  const out: string[] = [];
  for (const id of orderedNodeIds) {
    for (const edge of bySource.get(id) ?? []) {
      const comment = comments["edge:" + edge.id];
      if (comment) out.push(...printComment(comment, indent));
      out.push(`${indent}${edge.source}.${edge.sourceHandle ?? "output"} -> ${edge.target}.${edge.targetHandle ?? "input"}`);
    }
  }
  return out;
}

function printComment(comment: string, indent: string): string[] {
  return comment.split("\n").map((l) => `${indent}#${l.length > 0 ? " " + l : ""}`);
}

function printProperty(key: string, value: unknown, indent: string): string[] {
  if (typeof value === "string" && value.includes("\n")) {
    return [`${indent}${key} = """`, reindentBlockString(value, indent + INDENT), `${indent}"""`];
  }
  return [`${indent}${key} = ${printValue(value)}`];
}

function printValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return printStringLiteral(value);
  if (Array.isArray(value)) return `[${value.map(printValue).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([k, v]) => `${printKey(k)}: ${printValue(v)}`).join(", ")}}`;
  }
  throw new Error(`cannot print a value of type ${typeof value} in a .flow file`);
}

function printKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : printStringLiteral(key);
}

function formatNumber(n: number): string {
  if (Number.isNaN(n) || !Number.isFinite(n)) {
    throw new Error(`cannot print the non-finite number ${n} in a .flow file`);
  }
  return String(n);
}

function printStringLiteral(s: string): string {
  let out = '"';
  for (const ch of s) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\r":
        out += "\\r";
        break;
      default:
        out += ch;
    }
  }
  return out + '"';
}

/** Kahn's-algorithm topological sort restricted to one region, ties broken by each node's
 *  original position in `graph.nodes` (via `regions()`'s own iteration order) so re-printing an
 *  already-canonical file reproduces the identical order — required for idempotent formatting. */
function topoOrder(nodeIds: string[], edgeIds: string[], edgesById: Map<string, FlowEdge>): string[] {
  const indexOf = new Map(nodeIds.map((id, i) => [id, i]));
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const id of nodeIds) {
    dependents.set(id, []);
    remaining.set(id, 0);
  }
  for (const edgeId of edgeIds) {
    const edge = edgesById.get(edgeId)!;
    dependents.get(edge.source)!.push(edge.target);
    remaining.set(edge.target, (remaining.get(edge.target) ?? 0) + 1);
  }

  const ready = new Set(nodeIds.filter((id) => remaining.get(id) === 0));
  const result: string[] = [];
  while (ready.size > 0) {
    let best: string | undefined;
    let bestIdx = Infinity;
    for (const id of ready) {
      const idx = indexOf.get(id)!;
      if (idx < bestIdx) {
        bestIdx = idx;
        best = id;
      }
    }
    const id = best!;
    ready.delete(id);
    result.push(id);
    for (const dep of dependents.get(id) ?? []) {
      const remainingCount = (remaining.get(dep) ?? 0) - 1;
      remaining.set(dep, remainingCount);
      if (remainingCount === 0) ready.add(dep);
    }
  }
  // A cycle would leave nodes out of `result` — fall back to original order for those so a
  // (temporarily invalid, e.g. mid-edit) graph still prints something instead of throwing.
  for (const id of nodeIds) if (!result.includes(id)) result.push(id);
  return result;
}
