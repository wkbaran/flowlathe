import {
  activationKey,
  isNever,
  isValue,
  neverSlot,
  requiredToolsets,
  valueSlot,
  type FlowGraph,
  type FlowNode,
  type NeverReason,
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

/** The engine's full progress state — enough to resume a fresh engine instance from scratch. */
export interface EngineSnapshot {
  outputs: Record<string, Record<string, PortSlot>>;
}

interface EdgeRef {
  source: string;
  sourceHandle: string;
}

/**
 * A graph walker over the Activation/PortSlot readiness lattice. Reusable for both "run"
 * (dispatch every ready activation concurrently) and "step" (dispatch exactly one, in
 * deterministic order, and let the caller snapshot between steps) modes — see PLAN.md's
 * "The interpreter" section. Loop/Map bodies are a single node (via `parentId`), driven
 * atomically inside one dispatch; stepping treats a whole Loop/Map as one step (see CLAUDE.md).
 */
export class GraphEngine {
  private readonly run: Run;
  private readonly nodesById: Map<string, FlowNode>;
  private readonly bodyByParent: Map<string, FlowNode>;
  private readonly edgesByTargetPort: Map<string, Map<string, EdgeRef[]>>;
  private readonly outputs: Map<string, Record<string, PortSlot>>;
  private readonly rank: Map<string, number>;
  private readonly running = new Map<string, Promise<void>>();

  constructor(graph: FlowGraph, run: Run, initialOutputs?: Map<string, Record<string, PortSlot>>) {
    this.run = run;
    this.nodesById = new Map(graph.nodes.filter((n) => !n.parentId).map((n) => [n.id, n]));
    this.bodyByParent = new Map();
    for (const n of graph.nodes) {
      if (n.parentId) this.bodyByParent.set(n.parentId, n);
    }

    this.edgesByTargetPort = new Map();
    for (const edge of graph.edges) {
      if (!this.nodesById.has(edge.target)) continue; // body-scoped edges: handled by loop/map dispatch
      let byPort = this.edgesByTargetPort.get(edge.target);
      if (!byPort) {
        byPort = new Map();
        this.edgesByTargetPort.set(edge.target, byPort);
      }
      const port = edge.targetHandle ?? "input";
      const list = byPort.get(port) ?? [];
      list.push({ source: edge.source, sourceHandle: edge.sourceHandle ?? "output" });
      byPort.set(port, list);
    }

    this.outputs = initialOutputs ?? new Map();
    this.rank = computeTopoRank(this.nodesById, this.edgesByTargetPort);

    // Fails before any node dispatches — both fresh runs (`runGraph`) and every step-mode restore
    // (`GraphEngine.restore`, called once per `stepOnce`) go through this constructor, so a
    // workflow that needs a plugin toolset the server doesn't have configured never gets to run a
    // single node, and a plugin disconnected mid-stepping-session is caught on the very next step.
    const missing = run.tools.missingToolsets(requiredToolsets(graph));
    if (missing.length > 0) {
      throw new Error(
        `workflow is missing required plugin(s): ${missing.map((m) => `${m.toolset} (${m.reason})`).join("; ")}`,
      );
    }
  }

  static restore(graph: FlowGraph, run: Run, snapshot: EngineSnapshot): GraphEngine {
    const outputs = new Map(Object.entries(snapshot.outputs));
    return new GraphEngine(graph, run, outputs);
  }

  snapshot(): EngineSnapshot {
    return { outputs: Object.fromEntries(this.outputs) };
  }

  isDone(): boolean {
    return this.remaining().length === 0 && this.running.size === 0;
  }

  /** Ready node ids in deterministic order: topological rank, then node id. */
  readyNodeIds(): string[] {
    return this.remaining()
      .filter((id) => this.isReady(id))
      .sort((a, b) => (this.rank.get(a)! - this.rank.get(b)!) || a.localeCompare(b));
  }

  /** Dispatches every currently-ready activation, repeating until nothing is left. */
  async runToCompletion(): Promise<RunGraphResult> {
    while (this.remaining().length > 0 || this.running.size > 0) {
      const ready = this.readyNodeIds();
      for (const id of ready) this.admit(id);
      if (this.running.size === 0) {
        throw new Error(`cycle detected or missing upstream node among: ${this.remaining().join(", ")}`);
      }
      await Promise.race(this.running.values());
    }
    return { outputs: this.collectOutputs() };
  }

  /** Dispatches exactly one ready activation (or none, if done) and awaits its settlement. */
  async step(): Promise<{ nodeId: string } | undefined> {
    const ready = this.readyNodeIds();
    const nodeId = ready[0];
    if (!nodeId) return undefined;
    const promise = this.admit(nodeId);
    await promise;
    return { nodeId };
  }

  collectOutputs(): Record<string, string> {
    const outputs: Record<string, string> = {};
    for (const [nodeId, slots] of this.outputs) {
      const firstValue = Object.values(slots).find(isValue);
      if (firstValue) outputs[nodeId] = firstValue.value;
    }
    return outputs;
  }

  /** Nodes neither settled nor currently in flight — excluding `running` matters once a node's
   *  dispatch spans more than one microtask (e.g. any `await`), or `runToCompletion`'s loop can
   *  re-admit the same node a second time before its first dispatch finishes. */
  private remaining(): string[] {
    return [...this.nodesById.keys()].filter((id) => !this.outputs.has(id) && !this.running.has(id));
  }

  private admit(nodeId: string): Promise<void> {
    const promise = this.dispatchNode(this.nodesById.get(nodeId)!).finally(() => this.running.delete(nodeId));
    this.running.set(nodeId, promise);
    return promise;
  }

  private isReady(nodeId: string): boolean {
    const node = this.nodesById.get(nodeId)!;
    const spec = this.parseSpec(node);
    const ports = registry[node.type].inputPorts(spec);
    return ports.every((p) => this.portSlot(nodeId, p.name).kind !== "empty");
  }

  private portSlot(nodeId: string, port: string): PortSlot {
    const edges = this.edgesByTargetPort.get(nodeId)?.get(port) ?? [];
    if (edges.length === 0) return { kind: "empty" };

    let sawValue: PortSlot | undefined;
    let allNever = true;
    let allResolved = true;
    for (const edge of edges) {
      const sourceSlots = this.outputs.get(edge.source);
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

  private parseSpec(node: FlowNode): unknown {
    const data = registry[node.type].schema.parse(node.data) as Record<string, unknown>;
    return { id: node.id, ...data };
  }

  private async dispatchNode(node: FlowNode): Promise<void> {
    if (node.type === "loop" || node.type === "map") {
      await this.dispatchLoopOrMap(node);
      return;
    }

    const descriptor = registry[node.type];
    const spec = this.parseSpec(node);
    const ports = descriptor.inputPorts(spec);
    const slots = Object.fromEntries(ports.map((p) => [p.name, this.portSlot(node.id, p.name)]));

    const requiredNever = ports.find((p) => p.required && isNever(slots[p.name]!));
    if (requiredNever) {
      this.skipNode(node, spec, (slots[requiredNever.name] as Extract<PortSlot, { kind: "never" }>).reason);
      return;
    }
    if (ports.length > 0 && ports.every((p) => isNever(slots[p.name]!))) {
      this.skipNode(node, spec, (slots[ports[0]!.name] as Extract<PortSlot, { kind: "never" }>).reason);
      return;
    }

    const inputs = Object.fromEntries(
      Object.entries(slots)
        .filter((entry): entry is [string, Extract<PortSlot, { kind: "value" }>] => isValue(entry[1]))
        .map(([name, slot]) => [name, slot.value]),
    );
    const result = await descriptor.dispatch!(this.run, spec, inputs);
    const outPorts = descriptor.outputPorts(spec);
    const outSlots: Record<string, PortSlot> = {};
    for (const port of outPorts) {
      outSlots[port] = port in result ? valueSlot(result[port]!) : neverSlot("branch_not_taken");
    }
    this.outputs.set(node.id, outSlots);
  }

  private skipNode(node: FlowNode, spec: unknown, reason: NeverReason): void {
    const outPorts = registry[node.type].outputPorts(spec);
    const outSlots: Record<string, PortSlot> = {};
    for (const port of outPorts) outSlots[port] = neverSlot("upstream_skipped");
    this.outputs.set(node.id, outSlots);
    this.run.emit({ kind: "node_skipped", nodeId: node.id, reason });
  }

  private async dispatchLoopOrMap(node: FlowNode): Promise<void> {
    const bodyNode = this.bodyByParent.get(node.id);
    if (!bodyNode) {
      throw new Error(`"${node.type}" node "${node.id}" has no body node (expected a child with parentId set to it)`);
    }
    const bodyDescriptor = registry[bodyNode.type];

    const spec = this.parseSpec(node);
    const ports = registry[node.type].inputPorts(spec);
    const inputs = Object.fromEntries(
      ports.map((p) => {
        const slot = this.portSlot(node.id, p.name);
        return [p.name, isValue(slot) ? slot.value : ""];
      }),
    );

    const runBody = async (injected: Record<string, string>, index: number): Promise<string> => {
      const key = activationKey(bodyNode.id, [{ loop: node.id, index }]);
      const bodyData = bodyDescriptor.schema.parse(bodyNode.data) as Record<string, unknown>;
      // contextNodeId keeps a prompt body's conversation memory keyed by the static node, not
      // this iteration's scoped activation key — see CLAUDE.md.
      const bodySpec = { id: key, contextNodeId: bodyNode.id, ...bodyData };
      const result = await bodyDescriptor.dispatch!(this.run, bodySpec, injected);
      return firstOutputValue(bodyNode.type, bodySpec, result);
    };

    if (node.type === "loop") {
      const loopSpec = spec as LoopSpec;
      const result = await this.run.loop(loopSpec, inputs, (acc, i) => runBody({ [loopSpec.accPortName]: acc }, i));
      this.outputs.set(node.id, { result: valueSlot(result) });
    } else {
      const mapSpec = spec as MapSpec;
      const results = await this.run.map(mapSpec, inputs, (item, i) => runBody({ [mapSpec.itemPortName]: item }, i));
      this.outputs.set(node.id, { results: valueSlot(JSON.stringify(results)) });
    }
  }
}

function firstOutputValue(kind: NodeKind, spec: unknown, result: Record<string, string>): string {
  const ports = registry[kind].outputPorts(spec);
  for (const port of ports) {
    if (port in result) return result[port]!;
  }
  throw new Error(`node produced no value on any declared output port`);
}

/** Topological rank via Kahn's algorithm levels — used only to make step order deterministic. */
function computeTopoRank(
  nodesById: Map<string, FlowNode>,
  edgesByTargetPort: Map<string, Map<string, EdgeRef[]>>,
): Map<string, number> {
  const dependents = new Map<string, string[]>();
  const remainingDeps = new Map<string, number>();
  for (const id of nodesById.keys()) {
    dependents.set(id, []);
    remainingDeps.set(id, 0);
  }
  for (const [target, byPort] of edgesByTargetPort) {
    for (const edges of byPort.values()) {
      for (const edge of edges) {
        if (!nodesById.has(edge.source)) continue;
        dependents.get(edge.source)?.push(target);
        remainingDeps.set(target, (remainingDeps.get(target) ?? 0) + 1);
      }
    }
  }

  const rank = new Map<string, number>();
  let frontier = [...nodesById.keys()].filter((id) => (remainingDeps.get(id) ?? 0) === 0);
  let level = 0;
  const visited = new Set<string>();
  while (frontier.length > 0) {
    for (const id of frontier) {
      rank.set(id, level);
      visited.add(id);
    }
    const next: string[] = [];
    for (const id of frontier) {
      for (const dep of dependents.get(id) ?? []) {
        const remaining = (remainingDeps.get(dep) ?? 0) - 1;
        remainingDeps.set(dep, remaining);
        if (remaining === 0) next.push(dep);
      }
    }
    frontier = next;
    level++;
  }
  // any node not reached (cycle) still needs a rank so sorting doesn't throw; readiness will
  // never actually admit it, and runToCompletion/step surface the cycle as an error instead.
  for (const id of nodesById.keys()) {
    if (!visited.has(id)) rank.set(id, level);
  }
  return rank;
}

export async function runGraph(opts: RunGraphOptions): Promise<RunGraphResult> {
  return new GraphEngine(opts.graph, opts.run).runToCompletion();
}
