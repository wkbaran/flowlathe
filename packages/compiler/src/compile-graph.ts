import type { FlowGraph, FlowNode } from "@flowlathe/core";
import { emitTable } from "./emit-table.js";
import { topoLevels } from "./topo-levels.js";

export type ProviderKind = "mock" | "ollama";

export interface CompileOptions {
  /** providerId -> which adapter kind the generated script should construct for it. */
  providerKinds: Record<string, ProviderKind>;
}

export function compileGraph(graph: FlowGraph, opts: CompileOptions): string {
  const nodesById = new Map(graph.nodes.map((n) => [n.id, n]));
  const levels = topoLevels(graph);
  const incoming = buildIncoming(graph);
  const hasOutgoing = new Set(graph.edges.map((e) => e.source));
  const terminalNodeIds = graph.nodes.map((n) => n.id).filter((id) => !hasOutgoing.has(id));

  const specEntries = graph.nodes
    .map((node) => `  ${varName(node.id)}: ${JSON.stringify({ id: node.id, ...node.data })} as const,`)
    .join("\n");

  const statements = levels
    .map((level) => emitLevel(level, nodesById, incoming))
    .join("\n");

  const finishBindings = terminalNodeIds.map((id) => `${varName(id)}: ${varName(id)}.output`).join(", ");

  const usedProviderIds = new Set(graph.nodes.map((n) => (n.data["providerId"] as string) ?? ""));
  const providerEntries = [...usedProviderIds]
    .filter((id) => id in opts.providerKinds)
    .map((id) => `  ${JSON.stringify(id)}: { adapter: ${adapterCtor(opts.providerKinds[id]!)}, maxParallel: 4 },`)
    .join("\n");

  const importedAdapters = new Set([...usedProviderIds].map((id) => opts.providerKinds[id]).filter(Boolean));

  return `import { createRun, InMemoryBlobStore } from "@flowlathe/runtime";
import { SimpleScheduler${importedAdapters.has("mock") ? ", MockProviderAdapter" : ""}${importedAdapters.has("ollama") ? ", OllamaProviderAdapter" : ""} } from "@flowlathe/providers";

const N = {
${specEntries}
} as const;

async function main() {
  const scheduler = new SimpleScheduler({
${providerEntries}
  });
  const rt = createRun({
    host: {
      scheduler,
      blobs: new InMemoryBlobStore(),
      emit: (event) => console.log(JSON.stringify(event)),
      clock: { now: () => Date.now() },
    },
  });

${statements}

  rt.finish({ ${finishBindings} });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
`;
}

function emitLevel(
  level: string[],
  nodesById: Map<string, FlowNode>,
  incoming: Map<string, Map<string, string>>,
): string {
  if (level.length === 1) {
    const nodeId = level[0]!;
    return `  const ${varName(nodeId)} = ${callExpr(nodeId, nodesById, incoming)};`;
  }
  const decls = level.map(varName).join(", ");
  const calls = level.map((nodeId) => `    ${callExpr(nodeId, nodesById, incoming)},`).join("\n");
  return `  const [${decls}] = await Promise.all([\n${calls}\n  ]);`;
}

function callExpr(nodeId: string, nodesById: Map<string, FlowNode>, incoming: Map<string, Map<string, string>>): string {
  const node = nodesById.get(nodeId);
  if (!node) throw new Error(`unknown node "${nodeId}"`);
  const emitter = emitTable[node.type];
  const ports = emitter.inputPorts(node.data);
  const bindings = ports
    .map((port) => {
      const source = incoming.get(nodeId)?.get(port);
      if (!source) throw new Error(`node "${nodeId}" has no incoming edge bound to input "${port}"`);
      return `${port}: ${varName(source)}.output`;
    })
    .join(", ");
  return `await rt.${emitter.runtimeMethod}(N.${varName(nodeId)}, { ${bindings} })`;
}

function buildIncoming(graph: FlowGraph): Map<string, Map<string, string>> {
  const incoming = new Map<string, Map<string, string>>();
  for (const node of graph.nodes) incoming.set(node.id, new Map());
  for (const edge of graph.edges) {
    incoming.get(edge.target)?.set(edge.targetHandle ?? "input", edge.source);
  }
  return incoming;
}

function adapterCtor(kind: ProviderKind): string {
  if (kind === "mock") return "new MockProviderAdapter()";
  return 'new OllamaProviderAdapter({ baseUrl: process.env["OLLAMA_BASE_URL"] ?? "http://127.0.0.1:11434" })';
}

function varName(nodeId: string): string {
  return `n_${nodeId.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}
