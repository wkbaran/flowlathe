import { afterEach, describe, expect, it, vi } from "vitest";
import { failingFanOutGraph, failingFanOutResponses } from "./golden/failing-fan-out.js";
import { fanOutGraph, fanOutResponses } from "./golden/fan-out.js";
import { loopRouterBodyGraph, loopRouterBodyResponses } from "./golden/loop-router-body.js";
import { mapFanoutGraph, mapFanoutResponses } from "./golden/map-fanout.js";
import { mapMultinodeBodyGraph, mapMultinodeBodyResponses } from "./golden/map-multinode-body.js";
import { nestedMapInLoopGraph, nestedMapInLoopResponses } from "./golden/nested-map-in-loop.js";
import { routerDeepBranchGraph, routerDeepBranchResponses } from "./golden/router-deep-branch.js";
import { routerMergeGraph, routerMergeResponses } from "./golden/router-merge.js";
import { routerNestedGraph, routerNestedResponses } from "./golden/router-nested.js";
import { searchNodeEnv, searchNodeGraph, searchNodeNetTable, searchNodeResponses } from "./golden/search-node.js";
import { stateToolsGraph, stateToolsResponses } from "./golden/state-tools.js";
import { twoNodeChainGraph, twoNodeChainResponses } from "./golden/two-node-chain.js";
import { failureTraceViaCompiledScript, failureTraceViaInterpreter, traceViaCompiledScript, traceViaInterpreter } from "./parity.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    "matches for a deliberately failing fan-out: one sibling fails, the other is cancelled mid-flight",
    async () => {
      const viaInterpreter = await failureTraceViaInterpreter(failingFanOutGraph, failingFanOutResponses);
      const viaCompiled = failureTraceViaCompiledScript(failingFanOutGraph, failingFanOutResponses);
      expect(viaCompiled.finished).toEqual(viaInterpreter.finished);
      expect(viaCompiled.failed).toEqual(viaInterpreter.failed);
      expect(viaCompiled.cancelled).toEqual(viaInterpreter.cancelled);
      expect(viaInterpreter.finished).toEqual([]);
      expect(viaInterpreter.failed).toEqual([{ nodeId: "boom", error: "boom node exploded" }]);
      expect(viaInterpreter.cancelled).toEqual(["slow"]);
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
    "matches for a router branch 3 nodes deep before reconverging, plus a consumer after the merge",
    async () => {
      const viaInterpreter = await traceViaInterpreter(routerDeepBranchGraph, routerDeepBranchResponses);
      const viaCompiled = traceViaCompiledScript(routerDeepBranchGraph, routerDeepBranchResponses);
      expect(viaCompiled).toEqual(viaInterpreter);
      const nodeIds = viaInterpreter.map((e) => e.nodeId);
      expect(nodeIds).not.toContain("codeAnswer");
      expect(nodeIds).not.toContain("codeRefine");
      expect(nodeIds).not.toContain("codeFinal");
      expect(viaInterpreter.find((e) => e.nodeId === "final")?.output).toBe("ALL_DONE");
    },
    15_000,
  );

  it(
    "matches for a router nested inside another router's branch, with two levels of reconvergence",
    async () => {
      const viaInterpreter = await traceViaInterpreter(routerNestedGraph, routerNestedResponses);
      const viaCompiled = traceViaCompiledScript(routerNestedGraph, routerNestedResponses);
      expect(viaCompiled).toEqual(viaInterpreter);
      expect(viaInterpreter.map((e) => e.nodeId)).not.toContain("innerY");
      expect(viaInterpreter.map((e) => e.nodeId)).not.toContain("otherBranch");
      expect(viaInterpreter.find((e) => e.nodeId === "finalConsumer")?.output).toBe("ALL_DONE");
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
    "matches for a node with enableStateTools using the read_state/write_state tool loop",
    async () => {
      const viaInterpreter = await traceViaInterpreter(stateToolsGraph, stateToolsResponses);
      const viaCompiled = traceViaCompiledScript(stateToolsGraph, stateToolsResponses);
      expect(viaCompiled).toEqual(viaInterpreter);
      expect(viaInterpreter).toEqual([
        {
          nodeId: "a",
          renderedPrompt: 'CALL_TOOL: write_state {"entry":"notes","value":"hello"}',
          output: "DONE",
        },
      ]);
    },
    15_000,
  );

  it(
    "matches for a Map body that's a 2-node chain, not a single node",
    async () => {
      const viaInterpreter = await traceViaInterpreter(mapMultinodeBodyGraph, mapMultinodeBodyResponses);
      const viaCompiled = traceViaCompiledScript(mapMultinodeBodyGraph, mapMultinodeBodyResponses);
      expect(viaCompiled).toEqual(viaInterpreter);
      const mapEntry = viaInterpreter.find((e) => e.nodeId === "m");
      expect(mapEntry && JSON.parse(mapEntry.output)).toEqual(["B_X", "B_Y", "B_Z"]);
      expect(viaInterpreter.map((e) => e.nodeId).sort()).toEqual(
        ["a@m:0", "a@m:1", "a@m:2", "b@m:0", "b@m:1", "b@m:2", "m"].sort(),
      );
    },
    15_000,
  );

  it(
    "matches for a Loop body that's router -> {x, y} -> merge (branch pruning inside an iteration)",
    async () => {
      const viaInterpreter = await traceViaInterpreter(loopRouterBodyGraph, loopRouterBodyResponses);
      const viaCompiled = traceViaCompiledScript(loopRouterBodyGraph, loopRouterBodyResponses);
      expect(viaCompiled).toEqual(viaInterpreter);
      expect(viaInterpreter.map((e) => e.nodeId)).not.toContain("y@l:0");
      expect(viaInterpreter.find((e) => e.nodeId === "l")?.output).toBe("MERGED");
    },
    15_000,
  );

  it(
    "matches for a Loop whose body node is itself a Map with its own body (/-joined scoped ids)",
    async () => {
      const viaInterpreter = await traceViaInterpreter(nestedMapInLoopGraph, nestedMapInLoopResponses);
      const viaCompiled = traceViaCompiledScript(nestedMapInLoopGraph, nestedMapInLoopResponses);
      expect(viaCompiled).toEqual(viaInterpreter);
      expect(viaInterpreter.map((e) => e.nodeId).sort()).toEqual(["l", "leaf@l:0/m:0", "leaf@l:0/m:1", "m@l:0"].sort());
      expect(viaInterpreter.find((e) => e.nodeId === "l")?.output).toBe('["LX","LY"]');
    },
    15_000,
  );

  it(
    "matches for a search node backed by a stubbed net.fetch",
    async () => {
      vi.stubEnv("SEARXNG_BASE_URL", searchNodeEnv.SEARXNG_BASE_URL);
      const viaInterpreter = await traceViaInterpreter(searchNodeGraph, searchNodeResponses, searchNodeNetTable);
      const viaCompiled = traceViaCompiledScript(searchNodeGraph, searchNodeResponses, searchNodeNetTable, searchNodeEnv);
      expect(viaCompiled).toEqual(viaInterpreter);
      expect(viaInterpreter.find((e) => e.nodeId === "final")?.output).toBe("DONE");
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
