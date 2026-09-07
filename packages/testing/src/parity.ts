import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileGraph } from "@flowlathe/compiler";
import { createRunControl, type FlowGraph, type RunEvent } from "@flowlathe/core";
import { runGraph } from "@flowlathe/interpreter";
import { MockProviderAdapter, SimpleScheduler } from "@flowlathe/providers";
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
import { injectNetStubTable, netStubFetch } from "./net-stub.js";

export interface TraceEntry {
  nodeId: string;
  renderedPrompt: string;
  output: string;
}

/**
 * Normalized trace per the parity-testing design: node identity + what it saw/produced,
 * with concurrent siblings sorted canonically so dispatch-order nondeterminism doesn't
 * register as a mismatch.
 */
function traceFromEvents(events: RunEvent[]): TraceEntry[] {
  return events
    .filter((e): e is Extract<RunEvent, { kind: "node_finished" }> => e.kind === "node_finished")
    .map((e) => ({ nodeId: e.nodeId, renderedPrompt: e.renderedPrompt, output: e.output }))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

export async function traceViaInterpreter(
  graph: FlowGraph,
  responses: Map<string, string>,
  netTable: Map<string, string> = new Map(),
): Promise<TraceEntry[]> {
  const events: RunEvent[] = [];
  const scheduler = new SimpleScheduler({
    mock: { adapter: new MockProviderAdapter({ responses }), maxParallel: 4 },
  });
  const emit = (e: RunEvent): void => {
    events.push(e);
  };
  const state = createStateStore(emit, { decls: graph.state });
  const cancellation = createRunControl();
  const run = createRun({
    host: {
      scheduler,
      blobs: new InMemoryBlobStore(),
      emit,
      clock: { now: () => 0 },
      state,
      llmConfig: createLlmConfigStore(),
      context: createContextStore(),
      tools: createToolRegistry(stateToolset(state)),
      cancellation,
      net: { fetch: netStubFetch(netTable) },
      ...createSuspendRegistry(cancellation),
    },
  });
  await runGraph({ graph, run });
  return traceFromEvents(events);
}

export interface FailureTrace {
  /** Sorted by nodeId, as `TraceEntry[]` above. */
  finished: TraceEntry[];
  failed: { nodeId: string; error: string }[];
  /** Node ids, sorted. */
  cancelled: string[];
}

function failureTraceFromEvents(events: RunEvent[]): FailureTrace {
  return {
    finished: traceFromEvents(events),
    failed: events
      .filter((e): e is Extract<RunEvent, { kind: "node_failed" }> => e.kind === "node_failed")
      .map((e) => ({ nodeId: e.nodeId, error: e.error }))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    cancelled: events
      .filter((e): e is Extract<RunEvent, { kind: "node_cancelled" }> => e.kind === "node_cancelled")
      .map((e) => e.nodeId)
      .sort(),
  };
}

/** Like `traceViaInterpreter`, but for a fixture expected to fail: asserts `runGraph` rejects
 *  and reports which nodes finished/failed/were cancelled instead of the run's own outputs
 *  (PLAN-CANCELLATION.md §5.2 — the terminal error itself isn't comparable across engines, only
 *  the per-node event shape is). */
export async function failureTraceViaInterpreter(
  graph: FlowGraph,
  responses: Map<string, string>,
  netTable: Map<string, string> = new Map(),
): Promise<FailureTrace> {
  const events: RunEvent[] = [];
  const scheduler = new SimpleScheduler({
    mock: { adapter: new MockProviderAdapter({ responses }), maxParallel: 4 },
  });
  const emit = (e: RunEvent): void => {
    events.push(e);
  };
  const state = createStateStore(emit, { decls: graph.state });
  const cancellation = createRunControl();
  const run = createRun({
    host: {
      scheduler,
      blobs: new InMemoryBlobStore(),
      emit,
      clock: { now: () => 0 },
      state,
      llmConfig: createLlmConfigStore(),
      context: createContextStore(),
      tools: createToolRegistry(stateToolset(state)),
      cancellation,
      net: { fetch: netStubFetch(netTable) },
      ...createSuspendRegistry(cancellation),
    },
  });
  let rejected = false;
  try {
    await runGraph({ graph, run });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("expected runGraph to reject for a failure-trace fixture, but it resolved");
  return failureTraceFromEvents(events);
}

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(srcDir, "..");
const tsxBin = join(packageDir, "node_modules", ".bin", "tsx");
const scratchRoot = join(packageDir, ".parity-tmp");

function runCompiledScript(
  graph: FlowGraph,
  responses: Map<string, string>,
  netTable: Map<string, string>,
  env: Record<string, string>,
): { status: number | null; stderr: string; events: RunEvent[] } {
  const script = compileGraph(graph, { providers: { mock: { kind: "mock" } } });
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, "run-"));
  const file = join(dir, "flow.ts");
  writeFileSync(file, injectNetStubTable(injectResponseTable(script, responses), netTable));

  const result = spawnSync(tsxBin, [file], { encoding: "utf-8", cwd: packageDir, env: { ...process.env, ...env } });
  const events = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
  return { status: result.status, stderr: result.stderr, events };
}

export function traceViaCompiledScript(
  graph: FlowGraph,
  responses: Map<string, string>,
  netTable: Map<string, string> = new Map(),
  env: Record<string, string> = {},
): TraceEntry[] {
  const { status, stderr, events } = runCompiledScript(graph, responses, netTable, env);
  if (status !== 0) {
    throw new Error(`compiled script failed (exit ${String(status)}):\n${stderr}`);
  }
  return traceFromEvents(events);
}

/** Like `traceViaCompiledScript`, but for a fixture expected to fail: asserts the script exits
 *  non-zero rather than treating that as an error. The compiled script emits no `run_failed`
 *  event (`main().catch` only writes a stack to stderr — see CLAUDE.md), so the exit code is the
 *  only cross-engine-comparable signal that it failed at all; the per-node `finished`/`failed`/
 *  `cancelled` arrays are the actual parity anchor. */
export function failureTraceViaCompiledScript(
  graph: FlowGraph,
  responses: Map<string, string>,
  netTable: Map<string, string> = new Map(),
  env: Record<string, string> = {},
): FailureTrace {
  const { status, events } = runCompiledScript(graph, responses, netTable, env);
  if (status === 0) {
    throw new Error("expected compiled script to exit non-zero for a failure-trace fixture, but it succeeded");
  }
  return failureTraceFromEvents(events);
}

function injectResponseTable(script: string, responses: Map<string, string>): string {
  const entries = [...responses.entries()]
    .map(([key, value]) => `  [${JSON.stringify(key)}, ${JSON.stringify(value)}],`)
    .join("\n");
  return script.replace(
    "new MockProviderAdapter()",
    `new MockProviderAdapter({ responses: new Map([\n${entries}\n]) })`,
  );
}
