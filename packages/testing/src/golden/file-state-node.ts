import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

/**
 * Exercises PLAN-STATE-FILES.md's ambient state-binding mechanism: a Prompt node's template
 * references a declared state entry (`{{notes}}`) with NO wired edge on that port at all — only
 * the interpreter's `requiredPortsFor`/ambient-fallback in `run-graph.ts` and the compiler's
 * matching `bindPort` exemption in `compile-graph.ts` let this dispatch instead of erroring
 * "declares input port with no incoming edge". This is the two-sided parity risk §1.1 fact 4
 * calls out (the compiler independently re-derives ports through its own table) — confirmed by
 * temporarily reverting only the `compile-graph.ts` side and re-running this fixture, which then
 * failed with exactly that "no incoming edge" `invalid flow graph` error rather than passing
 * vacuously.
 *
 * Deliberately uses a plain `string`-typed entry, not `type: "file"` — a compiled script has no
 * `FLOWLATHE_STATE_FILES_ROOT` pipeline (PLAN-STATE-FILES.md §7: "deliberately not built" for this
 * pass), so a `type: "file"` entry would make the compiled script refuse to run at all
 * (`REQUIRED_FILE_STATE_ENTRIES`), which would defeat the point of a parity fixture that compares
 * a real execution trace across both engines. The ambient-binding mechanism under test here is
 * type-agnostic (PLAN-STATE-FILES.md L8) — a `string` entry exercises the exact same `bindPort`/
 * `requiredPortsFor` code paths a `file` entry would.
 */
export const fileStateNodeGraph: FlowGraph = {
  nodes: [
    {
      id: "a",
      type: "prompt",
      position: { x: 0, y: 0 },
      data: { template: "notes: {{notes}}", providerId: "mock", modelId: "m" },
    },
  ],
  edges: [],
  state: [{ name: "notes", type: "string", merge: "replace", initial: "hello" }],
};

export const fileStateNodeResponses = new Map([[mockResponseKey("a", "notes: hello"), "DONE"]]);
