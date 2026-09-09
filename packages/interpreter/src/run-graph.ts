import {
  activationKey,
  extractTemplateVars,
  isNever,
  isValue,
  neverSlot,
  requiredToolsets,
  terminalNodeIds,
  validateGraph,
  valueSlot,
  type FlowGraph,
  type FlowNode,
  type NeverReason,
  type NodeKind,
  type PortSlot,
  type ScopePath,
} from "@flowlathe/core";
import type { LoopSpec } from "@flowlathe/node-loop";
import type { MapSpec } from "@flowlathe/node-map";
import type { PromptSpec } from "@flowlathe/node-prompt";
import type { Run } from "@flowlathe/runtime";
import { registry, type PortDecl } from "./registry.js";

export interface RunGraphOptions {
  graph: FlowGraph;
  run: Run;
  /** Pre-resolves a node's output ports as if a dispatch had already produced them — how a
   *  trigger source (e.g. Discord) seeds a `trigger` node's real event data into a run, instead
   *  of letting it resolve to its canvas `testPayload` default. Applied once at construction,
   *  before the first readiness pass, by writing value slots directly — the seeded node is never
   *  actually dispatched. Node id -> port name -> value. */
  seed?: Record<string, Record<string, string>> | undefined;
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

/** The value injected into every entry port (a port named `port` with no in-region edge) of a
 *  Loop/Map body region, for one iteration. */
interface Injection {
  port: string;
  value: string;
}

export interface EngineOptions {
  /** Which region this engine walks. `undefined` = the top-level region. */
  ownerId?: string | undefined;
  /** Enclosing Loop/Map iterations, for activation keys and `contextNodeId` scoping. */
  scopePath?: ScopePath;
  /** The per-iteration value injected into this region's entry ports (see `EngineOptions.ownerId`). */
  injected?: Injection | undefined;
  initialOutputs?: Map<string, Record<string, PortSlot>>;
  /** See `RunGraphOptions.seed` — only ever meaningful for the top-level engine (a Loop/Map
   *  body's sub-engine has no seed of its own). */
  seed?: Record<string, Record<string, string>> | undefined;
}

/** Declared input port names for a node, independent of scope — used only for the top-level
 *  `validateGraph` call (R6/R7), which needs port names, not readiness. `validateGraph` itself
 *  applies the state-entry port exemption (PLAN-STATE-FILES.md L9) using `graph.state`, so this
 *  stays a plain, unfiltered port list. */
function portsOf(node: FlowNode): string[] {
  const data = registry[node.type].schema.parse(node.data) as Record<string, unknown>;
  return registry[node.type].inputPorts({ id: node.id, ...data }).map((p) => p.name);
}

/** A Prompt node's declared ports, minus any whose name matches a declared flow-State entry — an
 *  ambient binding resolved from `run.state.read(...)` rather than a wired edge (PLAN-STATE-
 *  FILES.md L8/L9). Every other node kind's ports are returned unfiltered; this is the one place
 *  (alongside `validateGraph`'s R7 and the compiler's `portsOf`/`callExpr`) that interprets
 *  `NodeEmitter.inputPorts`'s result as "needs an edge" — `NodeEmitter.inputPorts` itself is
 *  never touched, so every other node package is unaffected. */
function requiredPortsFor(node: FlowNode, ports: PortDecl[], graph: FlowGraph): PortDecl[] {
  if (node.type !== "prompt") return ports;
  const stateNames = new Set(graph.state.map((d) => d.name));
  return ports.filter((p) => !stateNames.has(p.name));
}

/**
 * A graph walker over the Activation/PortSlot readiness lattice, for one **region** — either the
 * top-level graph (`ownerId: undefined`) or one Loop/Map node's body (`ownerId: <that node's
 * id>`). Reusable for both "run" (dispatch every ready activation concurrently) and "step"
 * (dispatch exactly one, in deterministic order, and let the caller snapshot between steps) modes
 * — see PLAN.md's "The interpreter" section.
 *
 * A Loop/Map body can be an arbitrary multi-node subgraph (see PLAN-SUBGRAPH-BODIES.md): each
 * iteration spins up a fresh sub-`GraphEngine` scoped to that body region, with the per-iteration
 * value injected into any entry port and the iteration's result read off the region's one
 * terminal node (both inferred, not declared — see `@flowlathe/core`'s `regions.ts`). Nesting
 * (a body node that's itself a Loop/Map) falls out for free: the sub-engine's own
 * `dispatchLoopOrMap` recurses with a longer `scopePath`. Stepping still treats a whole Loop/Map
 * as one step — a sub-engine is created and discarded entirely inside one `dispatchNode` call, so
 * `EngineSnapshot` needs no change and body nodes aren't individually steppable (see CLAUDE.md).
 */
export class GraphEngine {
  private readonly run: Run;
  private readonly graph: FlowGraph;
  private readonly ownerId: string | undefined;
  private readonly scopePath: ScopePath;
  private readonly injected: Injection | undefined;
  private readonly nodesById: Map<string, FlowNode>;
  private readonly edgesByTargetPort: Map<string, Map<string, EdgeRef[]>>;
  private readonly outputs: Map<string, Record<string, PortSlot>>;
  private readonly rank: Map<string, number>;
  private readonly running = new Map<string, Promise<void>>();

  constructor(graph: FlowGraph, run: Run, opts: EngineOptions = {}) {
    this.run = run;
    this.graph = graph;
    this.ownerId = opts.ownerId;
    this.scopePath = opts.scopePath ?? [];
    this.injected = opts.injected;

    this.nodesById = new Map(graph.nodes.filter((n) => (n.parentId ?? undefined) === opts.ownerId).map((n) => [n.id, n]));

    this.edgesByTargetPort = new Map();
    for (const edge of graph.edges) {
      if (!this.nodesById.has(edge.source) || !this.nodesById.has(edge.target)) continue; // boundary-crossing or another region's edge
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

    this.outputs = opts.initialOutputs ?? new Map();
    if (opts.seed) {
      for (const [nodeId, ports] of Object.entries(opts.seed)) {
        this.outputs.set(nodeId, Object.fromEntries(Object.entries(ports).map(([port, value]) => [port, valueSlot(value)])));
      }
    }
    this.rank = computeTopoRank(this.nodesById, this.edgesByTargetPort);

    // Validation and the plugin-toolset gate only run for the top-level engine, not once per
    // Loop/Map iteration's sub-engine — both a fresh `runGraph()` call and every step-mode
    // `GraphEngine.restore()` go through this constructor, so an invalid graph or a workflow
    // needing a plugin toolset the server doesn't have configured never gets to run a single
    // node, and a plugin disconnected (or a graph edited into invalidity) mid-stepping-session is
    // caught on the very next step.
    if (opts.ownerId === undefined) {
      const problems = validateGraph(graph, { portsOf });
      if (problems.length > 0) {
        throw new Error(`invalid flow graph: ${problems.join("; ")}`);
      }

      const missing = run.tools.missingToolsets(requiredToolsets(graph));
      if (missing.length > 0) {
        throw new Error(
          `workflow is missing required plugin(s): ${missing.map((m) => `${m.toolset} (${m.reason})`).join("; ")}`,
        );
      }
    }
  }

  static restore(graph: FlowGraph, run: Run, snapshot: EngineSnapshot): GraphEngine {
    const outputs = new Map(Object.entries(snapshot.outputs));
    return new GraphEngine(graph, run, { initialOutputs: outputs });
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

  /** Dispatches every currently-ready activation, repeating until nothing is left. On the first
   *  rejection (PLAN-CANCELLATION.md D1), cancels the run and awaits every in-flight sibling's
   *  settlement before rethrowing — so nothing runs, emits, or persists after the caller sees
   *  this reject. */
  async runToCompletion(): Promise<RunGraphResult> {
    try {
      while (this.remaining().length > 0 || this.running.size > 0) {
        const ready = this.readyNodeIds();
        for (const id of ready) this.admit(id);
        if (this.running.size === 0) {
          throw new Error(`cycle detected or missing upstream node among: ${this.remaining().join(", ")}`);
        }
        await Promise.race(this.running.values());
      }
    } catch (err) {
      this.run.cancellation.cancel(err);
      // Snapshot into an array first: `admit`'s `.finally` deletes a settling node from `running`
      // before `Promise.race` above resolves, so the rejecting node is already gone from the map
      // by the time this catch runs, and the remaining entries delete themselves as the drain
      // proceeds — iterating the live map while it mutates is the bug this snapshot avoids. This
      // loop cannot re-admit: `admit` is only ever called from the loop above, which has exited.
      await Promise.allSettled([...this.running.values()]);
      throw err;
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

  /** This region's one terminal node's first non-`never` output value, or throws if every path
   *  through the region left it `never` (e.g. it sat on an untaken router branch). Only valid to
   *  call once `runToCompletion` has settled every node in this region. */
  private regionResult(kind: NodeKind): string {
    const terminalId = terminalNodeIds(this.graph, this.ownerId!)[0]!;
    const slots = this.outputs.get(terminalId);
    const value = slots && Object.values(slots).find(isValue);
    if (!value) {
      throw new Error(
        `${kind} body's terminal node "${terminalId}" was skipped — every path through the body must reach it`,
      );
    }
    return value.value;
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
    const ports = requiredPortsFor(node, registry[node.type].inputPorts(spec), this.graph);
    return ports.every((p) => this.portSlot(nodeId, p.name).kind !== "empty");
  }

  private portSlot(nodeId: string, port: string): PortSlot {
    const edges = this.edgesByTargetPort.get(nodeId)?.get(port) ?? [];
    if (edges.length === 0) {
      if (this.injected && this.injected.port === port) return valueSlot(this.injected.value);
      return { kind: "empty" };
    }

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

  /** `id` is the node's scoped activation key (`activationKey(node.id, this.scopePath)`) — plain
   *  `node.id` at the top level, or e.g. `node-2@node-1:0` inside a loop/map iteration, arbitrarily
   *  nested. `contextNodeId` is set whenever this region is scoped (i.e. this is a body node) so a
   *  Prompt body's conversation memory accumulates by the *static* node id across iterations
   *  rather than resetting each time — see CLAUDE.md. Harmless as an extra property on any other
   *  node kind's spec, since specs are built after `schema.parse`. */
  private parseSpec(node: FlowNode): unknown {
    const data = registry[node.type].schema.parse(node.data) as Record<string, unknown>;
    const id = activationKey(node.id, this.scopePath);
    return this.scopePath.length === 0 ? { id, ...data } : { id, contextNodeId: node.id, ...data };
  }

  private async dispatchNode(node: FlowNode): Promise<void> {
    const descriptor = registry[node.type];
    const spec = this.parseSpec(node);
    const ports = requiredPortsFor(node, descriptor.inputPorts(spec), this.graph);
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

    // PLAN-STATE-FILES.md L8/§4.4: a Prompt template variable with no wired edge, whose name
    // matches a declared State entry, is filled ambiently from `run.state.read(...)` rather than
    // from a port — `requiredPortsFor` already excluded it from `ports` above, so it's never
    // part of readiness/never-checks; it's resolved here, right before dispatch.
    if (node.type === "prompt") {
      for (const varName of extractTemplateVars((spec as PromptSpec).template)) {
        if (!(varName in inputs)) {
          const decl = this.graph.state.find((d) => d.name === varName);
          if (decl) inputs[varName] = String(this.run.state.read(varName));
        }
      }
    }

    if (node.type === "loop" || node.type === "map") {
      await this.dispatchLoopOrMap(node, spec, inputs);
      return;
    }

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
    this.run.emit({ kind: "node_skipped", nodeId: (spec as { id: string }).id, reason });
  }

  /** `spec`/`inputs` are already computed by `dispatchNode` — every port reaching here is a
   *  value: Loop/Map input ports are all `required: true` (registry.ts), so the `requiredNever`
   *  check above already skips (rather than dispatches) any node with a never-slotted port. */
  private async dispatchLoopOrMap(
    node: FlowNode,
    spec: unknown,
    inputs: Record<string, string>,
  ): Promise<void> {
    const runBody = async (port: string, value: string, index: number): Promise<string> => {
      const sub = new GraphEngine(this.graph, this.run, {
        ownerId: node.id,
        scopePath: [...this.scopePath, { loop: node.id, index }],
        injected: { port, value },
      });
      await sub.runToCompletion();
      return sub.regionResult(node.type);
    };

    if (node.type === "loop") {
      const loopSpec = spec as LoopSpec;
      const result = await this.run.loop(loopSpec, inputs, (acc, i) => runBody(loopSpec.accPortName, acc, i));
      this.outputs.set(node.id, { result: valueSlot(result) });
    } else {
      const mapSpec = spec as MapSpec;
      const results = await this.run.map(mapSpec, inputs, (item, i) => runBody(mapSpec.itemPortName, item, i));
      this.outputs.set(node.id, { results: valueSlot(JSON.stringify(results)) });
    }
  }
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
  return new GraphEngine(opts.graph, opts.run, opts.seed ? { seed: opts.seed } : {}).runToCompletion();
}
