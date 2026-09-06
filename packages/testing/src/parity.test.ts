import { describe, expect, it } from "vitest";
import { fanOutGraph, fanOutResponses } from "./golden/fan-out.js";
import { mapFanoutGraph, mapFanoutResponses } from "./golden/map-fanout.js";
import { routerMergeGraph, routerMergeResponses } from "./golden/router-merge.js";
import { twoNodeChainGraph, twoNodeChainResponses } from "./golden/two-node-chain.js";
import { traceViaCompiledScript, traceViaInterpreter } from "./parity.js";

describe("interpreter/compiler parity", () => {
  it(
    "matches for a two-node chain",
    async () => {
      const viaInterpreter = await traceViaInterpreter(twoNodeChainGraph, twoNodeChainResponses);
      const viaCompiled = traceViaCompiledScript(twoNodeChainGraph, twoNodeChainResponses);
      expect(viaCompiled).toEqual(viaInterpreter);
      expect(viaInterpreter).toEqual([
        { nodeId: "a", renderedPrompt: "start", output: "RESPONSE_A" },
        { nodeId: "b", renderedPrompt: "next: RESPONSE_A", output: "RESPONSE_B" },
      ]);
    },
    15_000,
  );

  it(
    "matches for a fan-out (Promise.all) level",
    async () => {
      const viaInterpreter = await traceViaInterpreter(fanOutGraph, fanOutResponses);
      const viaCompiled = traceViaCompiledScript(fanOutGraph, fanOutResponses);
      expect(viaCompiled).toEqual(viaInterpreter);
    },
    15_000,
  );

  it(
    "matches for a router+merge diamond (only the taken branch runs)",
    async () => {
      const viaInterpreter = await traceViaInterpreter(routerMergeGraph, routerMergeResponses);
      const viaCompiled = traceViaCompiledScript(routerMergeGraph, routerMergeResponses);
      expect(viaCompiled).toEqual(viaInterpreter);
      expect(viaInterpreter.map((e) => e.nodeId)).not.toContain("proseAnswer");
    },
    15_000,
  );

  it(
    "matches for a map fan-out over three items, joined in order",
    async () => {
      const viaInterpreter = await traceViaInterpreter(mapFanoutGraph, mapFanoutResponses);
      const viaCompiled = traceViaCompiledScript(mapFanoutGraph, mapFanoutResponses);
      expect(viaCompiled).toEqual(viaInterpreter);
      const mapEntry = viaInterpreter.find((e) => e.nodeId === "m");
      expect(mapEntry && JSON.parse(mapEntry.output)).toEqual(["X_RESULT", "Y_RESULT", "Z_RESULT"]);
    },
    15_000,
  );

  it(
    "surfaces a template-rendering regression as a missing mock key, not a silently different answer",
    async () => {
      const wrongTable = new Map([[twoNodeChainResponses.entries().next().value![0], "RESPONSE_A"]]);
      await expect(traceViaInterpreter(twoNodeChainGraph, wrongTable)).rejects.toThrow(/no mock response registered/);
    },
    15_000,
  );
});
