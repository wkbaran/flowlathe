import {
  activationKey,
  isNever,
  isValue,
  neverSlot,
  valueSlot,
  type FlowGraph,
  type FlowNode,
  type NodeKind,
  type PortSlot,
} from "@flowlathe/core";
import type { LoopSpec } from "@flowlathe/node-loop";
import type { MapSpec } from "@flowlathe/node-map";
import type { Run } from "@flowlathe/runtime";
import { registry } from "./registry.js";

export interface RunGraphOptions {
  graph: FlowGraph;
  run: Run;
}

export interface RunGraphResult {
  /** nodeId -> that node's first non-`never` output value (outer scope only). */
  outputs: Record<string, string>;
}

interface EdgeRef {
  source: string;
  sourceHandle: string;
}

interface EngineContext {
  run: Run;
  nodesById: Map<string, FlowNode>;
  bodyByParent: Map<string, FlowNode>;
  edgesByTargetPort: Map<string, Map<string, EdgeRef[]>>;
  outputs: Map<string, Record<string, PortSlot>>;
}

export async function runGraph({ graph, run }: RunGraphOptions): Promise<RunGraphResult> {
  const nodesById = new Map(graph.nodes.filter((n) => !n.parentId).map((n) => [n.id, n]));
  const bodyByParent = new Map<string, FlowNode>();
  for (const n of graph.nodes) {
    if (n.parentId) bodyByParent.set(n.parentId, n);
  }

  const edgesByTargetPort = new Map<string, Map<string, EdgeRef[]>>();
  for (const edge of graph.edges) {
    if (!nodesById.has(edge.target)) continue; // body-scoped edges are handled by loop/map dispatch, not here
    let byPort = edgesByTargetPort.get(edge.target);
    if (!byPort) {
      byPort = new Map();
      edgesByTargetPort.set(edge.target, byPort);
    }
    const port = edge.targetHandle ?? "input";
    const list = byPort.get(port) ?? [];
    list.push({ source: edge.source, sourceHandle: edge.sourceHandle ?? "output" });
    byPort.set(port, list);
  }

  const ctx: EngineContext = { run, nodesById, bodyByParent, edgesByTargetPort, outputs: new Map() };

  const remaining = new Set(nodesById.keys());
  const running = new Map<string, Promise<void>>();

  while (remaining.size > 0 || running.size > 0) {
    const ready = [...remaining].filter((id) => isReady(id, ctx));
    for (const id of ready) {
      remaining.delete(id);
      const promise = dispatchNode(ctx.nodesById.get(id)!, ctx).finally(() => running.delete(id));
      running.set(id, promise);
    }
    if (running.size === 0) {
      throw new Error(`cycle detected or missing upstream node among: ${[...remaining].join(", ")}`);
    }
    await Promise.race(running.values());
  }

  const outputs: Record<string, string> = {};
  for (const [nodeId, slots] of ctx.outputs) {
    const firstValue = Object.values(slots).find(isValue);
    if (firstValue) outputs[nodeId] = firstValue.value;
  }
  return { outputs };
}

function isReady(nodeId: string, ctx: EngineContext): boolean {
  const node = ctx.nodesById.get(nodeId)!;
  const spec = parseSpec(node, ctx);
  const ports = registry[node.type].inputPorts(spec);
  return ports.every((p) => portSlot(nodeId, p.name, ctx).kind !== "empty");
}

function portSlot(nodeId: string, port: string, ctx: EngineContext): PortSlot {
  const edges = ctx.edgesByTargetPort.get(nodeId)?.get(port) ?? [];
  if (edges.length === 0) return { kind: "empty" };

  let sawValue: PortSlot | undefined;
  let allNever = true;
  let allResolved = true;
  for (const edge of edges) {
    const sourceSlots = ctx.outputs.get(edge.source);
    const slot = sourceSlots?.[edge.sourceHandle];
    if (!slot) {
      allResolved = false;
      allNever = false;
      continue;
    }
    if (isValue(slot)) sawValue = slot;
    if (!isNever(slot)) allNever = false;
  }
  if (sawValue) return sawValue;
  if (allResolved && allNever) return neverSlot("upstream_skipped");
  return { kind: "empty" };
}

function parseSpec(node: FlowNode, ctx: EngineContext): unknown {
  void ctx;
  const data = registry[node.type].schema.parse(node.data) as Record<string, unknown>;
  return { id: node.id, ...data };
}

async function dispatchNode(node: FlowNode, ctx: EngineContext): Promise<void> {
  if (node.type === "loop" || node.type === "map") {
    await dispatchLoopOrMap(node, ctx);
    return;
  }

  const descriptor = registry[node.type];
  const spec = parseSpec(node, ctx);
  const ports = descriptor.inputPorts(spec);
  const slots = Object.fromEntries(ports.map((p) => [p.name, portSlot(node.id, p.name, ctx)]));

  if (ports.some((p) => p.required && isNever(slots[p.name]!))) {
    skipNode(node, spec, ctx);
    return;
  }
  if (ports.length > 0 && ports.every((p) => isNever(slots[p.name]!))) {
    skipNode(node, spec, ctx);
    return;
  }

  const inputs = Object.fromEntries(
    Object.entries(slots)
      .filter((entry): entry is [string, Extract<PortSlot, { kind: "value" }>] => isValue(entry[1]))
      .map(([name, slot]) => [name, slot.value]),
  );
  const result = await descriptor.dispatch!(ctx.run, spec, inputs);
  const outPorts = descriptor.outputPorts(spec);
  const outSlots: Record<string, PortSlot> = {};
  for (const port of outPorts) {
    outSlots[port] = port in result ? valueSlot(result[port]!) : neverSlot("branch_not_taken");
  }
  ctx.outputs.set(node.id, outSlots);
}

function skipNode(node: FlowNode, spec: unknown, ctx: EngineContext): void {
  const outPorts = registry[node.type].outputPorts(spec);
  const outSlots: Record<string, PortSlot> = {};
  for (const port of outPorts) outSlots[port] = neverSlot("upstream_skipped");
  ctx.outputs.set(node.id, outSlots);
}

function firstOutputValue(kind: NodeKind, spec: unknown, result: Record<string, string>): string {
  const ports = registry[kind].outputPorts(spec);
  for (const port of ports) {
    if (port in result) return result[port]!;
  }
  throw new Error(`node produced no value on any declared output port`);
}

async function dispatchLoopOrMap(node: FlowNode, ctx: EngineContext): Promise<void> {
  const bodyNode = ctx.bodyByParent.get(node.id);
  if (!bodyNode) {
    throw new Error(`"${node.type}" node "${node.id}" has no body node (expected a child with parentId set to it)`);
  }
  const bodyDescriptor = registry[bodyNode.type];

  const spec = parseSpec(node, ctx);
  const ports = registry[node.type].inputPorts(spec);
  const inputs = Object.fromEntries(
    ports.map((p) => {
      const slot = portSlot(node.id, p.name, ctx);
      return [p.name, isValue(slot) ? slot.value : ""];
    }),
  );

  const runBody = async (injected: Record<string, string>, index: number): Promise<string> => {
    const key = activationKey(bodyNode.id, [{ loop: node.id, index }]);
    const bodyData = bodyDescriptor.schema.parse(bodyNode.data) as Record<string, unknown>;
    const bodySpec = { id: key, ...bodyData };
    const result = await bodyDescriptor.dispatch!(ctx.run, bodySpec, injected);
    return firstOutputValue(bodyNode.type, bodySpec, result);
  };

  if (node.type === "loop") {
    const loopSpec = spec as LoopSpec;
    const result = await ctx.run.loop(loopSpec, inputs, (acc, i) => runBody({ [loopSpec.accPortName]: acc }, i));
    ctx.outputs.set(node.id, { result: valueSlot(result) });
  } else {
    const mapSpec = spec as MapSpec;
    const results = await ctx.run.map(mapSpec, inputs, (item, i) => runBody({ [mapSpec.itemPortName]: item }, i));
    ctx.outputs.set(node.id, { results: valueSlot(JSON.stringify(results)) });
  }
}
