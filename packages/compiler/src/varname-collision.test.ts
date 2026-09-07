import type { FlowGraph } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile-graph.js";

const providers = { mock: { kind: "mock" as const } };
const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

/**
 * Two ids ("a-b" and "a_b") that sanitize to the same base ("n_a_b") — see
 * PLAN-COMPILER-VARNAME.md. Same-region collisions used to be loud (`SyntaxError` from a
 * duplicate `const`/destructuring binding); the cross-region case is covered separately by the
 * `colliding-ids` golden parity fixture, since it's silent rather than a syntax error.
 */
describe("compileGraph — colliding node ids get distinct generated names", () => {
  it("disambiguates a fan-out level (two colliding ids at the same topo level)", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "a-b", type: "prompt", position: { x: 0, y: 0 }, data: promptData("first") },
        { id: "a_b", type: "prompt", position: { x: 0, y: 1 }, data: promptData("second") },
      ],
      edges: [],
      state: [],
    };
    const script = compileGraph(graph, { providers });
    expect(script).toContain("await allOrCancel(rt.cancellation, [");
    // both nodes disambiguated, and the two generated names are different
    const names = [...script.matchAll(/const \[(n_a_b__[0-9a-f]{8}), (n_a_b__[0-9a-f]{8})\]/g)];
    expect(names).toHaveLength(1);
    expect(names[0]![1]).not.toBe(names[0]![2]);
  });

  it("disambiguates a sequential chain (two colliding ids, one feeding the other)", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "a-b", type: "prompt", position: { x: 0, y: 0 }, data: promptData("first") },
        { id: "a_b", type: "prompt", position: { x: 1, y: 0 }, data: promptData("next: {{input}}") },
      ],
      edges: [{ id: "e1", source: "a-b", target: "a_b", targetHandle: "input" }],
      state: [],
    };
    const script = compileGraph(graph, { providers });
    const declaredNames = [...script.matchAll(/const (n_a_b__[0-9a-f]{8}) = await rt\.prompt/g)].map((m) => m[1]!);
    expect(declaredNames).toHaveLength(2);
    expect(declaredNames[0]).not.toBe(declaredNames[1]);
    // the second node's binding reads from the FIRST node's own generated name, not its own
    expect(script).toContain(`${declaredNames[1]} = await rt.prompt(N.${declaredNames[1]}, { input: ${declaredNames[0]}.output });`);
  });

  it("assigns each colliding node the same generated name regardless of graph.nodes array order (D4)", () => {
    // Reversing graph.nodes legitimately reorders independent emitted lines (topoLevels'
    // frontier, and the N table's key order, both preserve input array order — a pre-existing,
    // unrelated property of this compiler, nothing to do with name generation). What D4 actually
    // guarantees is narrower and is what matters for diff-churn: which NAME a given node id gets
    // never depends on the other claimants' order — a "first-claimant-keeps-the-plain-name"
    // scheme would flip that per-id assignment when the array is reversed; the hash-suffix scheme
    // does not. So compare the id -> generated-name mapping (extracted from each script's N
    // table), not the scripts' raw byte order.
    const nodes: FlowGraph["nodes"] = [
      { id: "a-b", type: "prompt", position: { x: 0, y: 0 }, data: promptData("first") },
      { id: "a_b", type: "prompt", position: { x: 0, y: 1 }, data: promptData("second") },
      { id: "a.b", type: "prompt", position: { x: 0, y: 2 }, data: promptData("third") },
    ];
    const forward: FlowGraph = { nodes, edges: [], state: [] };
    const reversed: FlowGraph = { nodes: [...nodes].reverse(), edges: [], state: [] };

    const idToName = (script: string): Record<string, string> => {
      const entries = [...script.matchAll(/^ {2}(n_a_b(?:__[0-9a-f]{8})?): \{"id":"([^"]+)"/gm)];
      return Object.fromEntries(entries.map((m) => [m[2]!, m[1]!]));
    };

    const forwardMap = idToName(compileGraph(forward, { providers }));
    const reversedMap = idToName(compileGraph(reversed, { providers }));
    expect(Object.keys(forwardMap).sort()).toEqual(["a-b", "a.b", "a_b"]);
    expect(reversedMap).toEqual(forwardMap);
  });

  it("throws a clear compile error on the residual case: a node id equal to another's disambiguated name", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "a-b", type: "prompt", position: { x: 0, y: 0 }, data: promptData("first") },
        { id: "a_b", type: "prompt", position: { x: 0, y: 1 }, data: promptData("second") },
      ],
      edges: [],
      state: [],
    };
    // Discover the real disambiguated name the collision above produces (e.g. "n_a_b__1a2b3c4d"),
    // then plant a third node whose OWN id — once base()'d (which always re-prepends "n_") —
    // resolves to that exact string: strip the leading "n_" so `base(clashingId) === disambiguated`.
    const probe = compileGraph(graph, { providers });
    const disambiguated = probe.match(/n_a_b__[0-9a-f]{8}/)![0];
    const clashingId = disambiguated.slice("n_".length);
    const clashing: FlowGraph = {
      nodes: [...graph.nodes, { id: clashingId, type: "prompt", position: { x: 1, y: 0 }, data: promptData("third") }],
      edges: [],
      state: [],
    };
    expect(() => compileGraph(clashing, { providers })).toThrow(/generated identifier/);
  });
});
