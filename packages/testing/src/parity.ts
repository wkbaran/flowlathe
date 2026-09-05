import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ProviderKind, compileGraph } from "@flowlathe/compiler";
import type { FlowGraph, RunEvent } from "@flowlathe/core";
import { runGraph } from "@flowlathe/interpreter";
import { MockProviderAdapter, SimpleScheduler } from "@flowlathe/providers";
import { InMemoryBlobStore, createRun } from "@flowlathe/runtime";

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
): Promise<TraceEntry[]> {
  const events: RunEvent[] = [];
  const scheduler = new SimpleScheduler({
    mock: { adapter: new MockProviderAdapter({ responses }), maxParallel: 4 },
  });
  const run = createRun({
    host: {
      scheduler,
      blobs: new InMemoryBlobStore(),
      emit: (e) => events.push(e),
      clock: { now: () => 0 },
    },
  });
  await runGraph({ graph, run });
  return traceFromEvents(events);
}

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(srcDir, "..");
const tsxBin = join(packageDir, "node_modules", ".bin", "tsx");
const scratchRoot = join(packageDir, ".parity-tmp");

export function traceViaCompiledScript(graph: FlowGraph, responses: Map<string, string>): TraceEntry[] {
  const providerKinds: Record<string, ProviderKind> = { mock: "mock" };
  const script = compileGraph(graph, { providerKinds });
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, "run-"));
  const file = join(dir, "flow.ts");
  writeFileSync(file, injectResponseTable(script, responses));

  const result = spawnSync(tsxBin, [file], { encoding: "utf-8", cwd: packageDir });
  if (result.status !== 0) {
    throw new Error(`compiled script failed (exit ${String(result.status)}):\n${result.stderr}`);
  }
  const events = result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RunEvent);
  return traceFromEvents(events);
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
