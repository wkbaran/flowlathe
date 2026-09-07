import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

/**
 * A `search` node fed by an upstream prompt's output, whose result in turn feeds a downstream
 * prompt — exercises the interpreter/compiler through the `search` port-shape (`extractTemplateVars`
 * on `queryTemplate`, output port `results`) and `RuntimeHost.net.fetch` end to end, stubbed via
 * `netStubFetch`/`injectNetStubTable` (see PLAN-INTEGRATIONS.md §5.3's parity-harness design).
 * `SEARXNG_BASE_URL` must be set to `searchNodeEnv.SEARXNG_BASE_URL` for both the interpreter
 * (via `vi.stubEnv`) and the compiled script (via `traceViaCompiledScript`'s `env` param) — the
 * exact URL requested (and thus the stub table's key) depends on it.
 */
export const searchNodeGraph: FlowGraph = {
  nodes: [
    { id: "seed", type: "prompt", position: { x: 0, y: 0 }, data: promptData("give me a topic") },
    { id: "s", type: "search", position: { x: 1, y: 0 }, data: { queryTemplate: "{{topic}}" } },
    { id: "final", type: "prompt", position: { x: 2, y: 0 }, data: promptData("results: {{r}}") },
  ],
  edges: [
    { id: "e0", source: "seed", target: "s", targetHandle: "topic" },
    { id: "e1", source: "s", target: "final", sourceHandle: "results", targetHandle: "r" },
  ],
  state: [],
};

export const searchNodeEnv = { SEARXNG_BASE_URL: "http://searxng.invalid" };

const SEARCH_RESULTS_JSON =
  '[{"title":"Flowlathe","url":"https://example.com/flowlathe","snippet":"A flow tool","engine":"google"}]';

export const searchNodeNetTable = new Map([
  [
    "http://searxng.invalid/search?q=flowlathe&format=json&pageno=1",
    JSON.stringify({
      results: [{ title: "Flowlathe", url: "https://example.com/flowlathe", content: "A flow tool", score: 1, engine: "google" }],
    }),
  ],
]);

export const searchNodeResponses = new Map([
  [mockResponseKey("seed", "give me a topic"), "flowlathe"],
  [mockResponseKey("final", `results: ${SEARCH_RESULTS_JSON}`), "DONE"],
]);
