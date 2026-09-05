import type { FlowGraph, FlowNode } from "@flowlathe/core";
import type { Run } from "@flowlathe/runtime";
import { dispatchTable, nodeSchemas } from "./registry.js";

export interface RunGraphOptions {
  graph: FlowGraph;
  run: Run;
}

export interface RunGraphResult {
  /** nodeId -> that node's single output value. */
  outputs: Record<string, string>;
  /** dispatch order, grouped by level (nodes within a level ran concurrently). */
  levels: string[][];
}

interface IncomingEdge {
  source: string;
  targetHandle: string;
}

export async function runGraph({ graph, run }: RunGraphOptions): Promise<RunGraphResult> {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const incoming = new Map<string, IncomingEdge[]>();
  for (const node of graph.nodes) incoming.set(node.id, []);
  for (const edge of graph.edges) {
    const edges = incoming.get(edge.target);
    if (!edges) throw new Error(`edge "${edge.id}" targets unknown node "${edge.target}"`);
    edges.push({ source: edge.source, targetHandle: edge.targetHandle ?? "input" });
  }

  const outputs: Record<string, string> = {};
  const done = new Set<string>();
  const remaining = new Set(graph.nodes.map((n) => n.id));
  const levels: string[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => incoming.get(id)!.every((e) => done.has(e.source)));
    if (ready.length === 0) {
      throw new Error(`cycle detected or missing upstream node among: ${[...remaining].join(", ")}`);
    }
    await Promise.all(ready.map((nodeId) => dispatchNode(nodesById.get(nodeId)!, incoming, outputs, run)));
    for (const nodeId of ready) {
      done.add(nodeId);
      remaining.delete(nodeId);
    }
    levels.push(ready);
  }

  return { outputs, levels };
}

async function dispatchNode(
  node: FlowNode,
  incoming: Map<string, IncomingEdge[]>,
  outputs: Record<string, string>,
  run: Run,
): Promise<void> {
  const inputs: Record<string, string> = {};
  for (const edge of incoming.get(node.id)!) {
    inputs[edge.targetHandle] = outputs[edge.source]!;
  }
  const schema = nodeSchemas[node.type];
  const data = schema.parse(node.data) as Record<string, unknown>;
  const spec = { id: node.id, ...data };
  const dispatch = dispatchTable[node.type];
  outputs[node.id] = await dispatch(run, spec, inputs);
}
