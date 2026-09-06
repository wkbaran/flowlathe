import type { FlowGraph } from "@flowlathe/core";
import { mockResponseKey } from "@flowlathe/providers";

/** Exercises the read_state/write_state tool loop end-to-end — this is the exact path that was
 *  silently broken in compiled scripts before compile-graph.ts started emitting a `tools:` field
 *  on the runtime host (it crashed with "Cannot read properties of undefined (reading 'specsFor')"
 *  the moment a node had `enableStateTools: true`, since no golden fixture had ever exercised
 *  tool-calling through the compiled-script path). */
export const stateToolsGraph: FlowGraph = {
  nodes: [
    {
      id: "a",
      type: "prompt",
      position: { x: 0, y: 0 },
      data: {
        template: 'CALL_TOOL: write_state {"entry":"notes","value":"hello"}',
        providerId: "mock",
        modelId: "m",
        enableStateTools: true,
      },
    },
  ],
  edges: [],
  state: [{ name: "notes", type: "string", merge: "append" }],
};

const secondRoundPrompt =
  'CALL_TOOL: write_state {"entry":"notes","value":"hello"}\n[tool calls]\n[write_state notes]: ok\nContinue.';

export const stateToolsResponses = new Map([[mockResponseKey("a", secondRoundPrompt), "DONE"]]);
