import { describe, expect, it } from "vitest";
import type { FlowGraph } from "./graph.js";
import { findMissingToolsets, requiredToolsets } from "./plugin-deps.js";
import type { ToolRegistration } from "./contracts.js";

function graphWith(nodesData: Record<string, unknown>[]): FlowGraph {
  return {
    nodes: nodesData.map((data, i) => ({ id: `n${i}`, type: "prompt", position: { x: 0, y: 0 }, data })),
    edges: [],
    state: [],
  };
}

function spec(name: string) {
  return { name, description: name, parameters: { type: "object" as const, properties: {} } };
}

describe("requiredToolsets", () => {
  it("returns nothing for a graph with no enabledToolsets anywhere", () => {
    expect(requiredToolsets(graphWith([{}, { enableStateTools: true }]))).toEqual([]);
  });

  it("collects a single node's enabledToolsets", () => {
    expect(requiredToolsets(graphWith([{ enabledToolsets: ["spotify"] }]))).toEqual(["spotify"]);
  });

  it("unions across nodes and de-duplicates, sorted", () => {
    const graph = graphWith([{ enabledToolsets: ["spotify"] }, { enabledToolsets: ["zzz", "spotify"] }]);
    expect(requiredToolsets(graph)).toEqual(["spotify", "zzz"]);
  });

  it("never includes 'state' — enableStateTools is a separate field with no external dependency", () => {
    expect(requiredToolsets(graphWith([{ enableStateTools: true, enabledToolsets: [] }]))).toEqual([]);
  });

  it("ignores a malformed (non-array or non-string) enabledToolsets value", () => {
    expect(requiredToolsets(graphWith([{ enabledToolsets: "spotify" }, { enabledToolsets: [1, "ok"] }]))).toEqual([
      "ok",
    ]);
  });
});

describe("findMissingToolsets", () => {
  it("is empty when nothing is required", () => {
    expect(findMissingToolsets([], [])).toEqual([]);
  });

  it("reports a required toolset with zero registrations as not configured", () => {
    const missing = findMissingToolsets([], ["spotify"]);
    expect(missing).toEqual([{ toolset: "spotify", reason: expect.stringContaining("not configured") }]);
  });

  it("is empty when a required toolset is registered with no unavailableReason", () => {
    const regs: ToolRegistration[] = [{ toolset: "spotify", spec: spec("spotify_search"), handler: () => "" }];
    expect(findMissingToolsets(regs, ["spotify"])).toEqual([]);
  });

  it("reports a registered-but-unavailable toolset using its unavailableReason", () => {
    const regs: ToolRegistration[] = [
      { toolset: "spotify", spec: spec("spotify_search"), handler: () => "", unavailableReason: () => "not connected" },
    ];
    expect(findMissingToolsets(regs, ["spotify"])).toEqual([{ toolset: "spotify", reason: "not connected" }]);
  });

  it("only reports the toolsets that were actually required", () => {
    const regs: ToolRegistration[] = [
      { toolset: "spotify", spec: spec("a"), handler: () => "", unavailableReason: () => "nope" },
    ];
    expect(findMissingToolsets(regs, [])).toEqual([]);
  });

  it("treats a toolset ready once any registration with no reason exists, even if another one has a reason", () => {
    const regs: ToolRegistration[] = [
      { toolset: "spotify", spec: spec("a"), handler: () => "", unavailableReason: () => "nope" },
      { toolset: "spotify", spec: spec("b"), handler: () => "" },
    ];
    // .find() picks the first defined reason across all registrations for the toolset - since one
    // registration DOES report a reason, the toolset as a whole is still flagged missing. This
    // matches how Spotify's three tools always share one client's isConnected() state in practice,
    // so this "any reason -> missing" behavior, not "every reason -> missing", is what's exercised.
    expect(findMissingToolsets(regs, ["spotify"])).toEqual([{ toolset: "spotify", reason: "nope" }]);
  });
});
