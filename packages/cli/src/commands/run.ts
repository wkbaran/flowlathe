import { readFile } from "node:fs/promises";
import { createRunControl, requiredToolsets, type RunEvent } from "@flowlathe/core";
import { parse } from "@flowlathe/dsl";
import { runGraph } from "@flowlathe/interpreter";
import { SimpleScheduler } from "@flowlathe/providers";
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
import { parseArgs } from "../args.js";
import { buildScheduler, resolveProviders } from "../providers.js";
import { checkGraph } from "../validate.js";

/** Headless interpreter run — same host shape a compiled script's generated `main()` builds
 *  (PLAN-FLOW-DSL.md §5: "streams RunEvent JSON to stdout, same shape a compiled script
 *  prints"). Unlike a compiled script it has no per-flow codegen step: it drives the graph
 *  through `@flowlathe/interpreter`'s `runGraph` directly, the same engine step-mode uses. */
export async function cmdRun(argv: string[]): Promise<number> {
  const { positional } = parseArgs(argv);
  const file = positional[0];
  if (!file) {
    console.error("usage: flowlathe run <file>");
    return 1;
  }

  const text = await readFile(file, "utf8");
  const { graph } = parse(text);
  const problems = checkGraph(graph);
  if (problems.length > 0) {
    for (const p of problems) console.error(p.nodeId ? `node "${p.nodeId}": ${p.message}` : p.message);
    return 1;
  }

  // A compiled script gates the same way (REQUIRED_PLUGIN_TOOLSETS) — this CLI has no plugin
  // registry (Spotify/MCP/etc.) to satisfy a non-"state" toolset with, and refusing up front
  // beats a confusing crash mid-run on the first tool-enabled prompt node.
  const pluginToolsets = requiredToolsets(graph).filter((t) => t !== "state");
  if (pluginToolsets.length > 0) {
    console.error(`this flow requires plugin toolset(s) not supported by "flowlathe run": ${pluginToolsets.join(", ")}`);
    return 1;
  }

  const providers = resolveProviders(graph);
  const scheduler = new SimpleScheduler(buildScheduler(providers));
  const emit = (event: RunEvent): void => console.log(JSON.stringify(event));
  const state = createStateStore(emit, { decls: graph.state });
  const cancellation = createRunControl();
  const run = createRun({
    host: {
      scheduler,
      blobs: new InMemoryBlobStore(),
      emit,
      clock: { now: () => Date.now() },
      state,
      llmConfig: createLlmConfigStore(),
      context: createContextStore(),
      tools: createToolRegistry(stateToolset(state)),
      cancellation,
      net: { fetch: globalThis.fetch },
      ...createSuspendRegistry(cancellation),
    },
  });

  const hasOutgoing = new Set(graph.edges.map((e) => e.source));
  const terminalNodeIds = graph.nodes.map((n) => n.id).filter((id) => !hasOutgoing.has(id));

  try {
    const { outputs } = await runGraph({ graph, run });
    run.finish(Object.fromEntries(terminalNodeIds.map((id) => [id, outputs[id]])));
    return 0;
  } catch (err) {
    emit({ kind: "run_failed", error: (err as Error).message });
    return 1;
  }
}
