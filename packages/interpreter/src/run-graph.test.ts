import type { FlowGraph, RunEvent } from "@flowlathe/core";
import { InMemoryBlobStore, createRun } from "@flowlathe/runtime";
import { MockProviderAdapter, SimpleScheduler } from "@flowlathe/providers";
import { describe, expect, it } from "vitest";
import { runGraph } from "./run-graph.js";

function makeRun(): { run: ReturnType<typeof createRun>; events: RunEvent[] } {
  const events: RunEvent[] = [];
  const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 4 } });
  const run = createRun({
    host: {
      scheduler,
      blobs: new InMemoryBlobStore(),
      emit: (e) => events.push(e),
      clock: { now: () => 0 },
    },
  });
  return { run, events };
}

describe("runGraph", () => {
  it("runs a two-node chain, feeding node A's output into node B's template", async () => {
    const { run } = makeRun();
    const graph: FlowGraph = {
      nodes: [
        { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "start", providerId: "mock", modelId: "m" } },
        { id: "b", type: "prompt", position: { x: 1, y: 0 }, data: { template: "next: {{input}}", providerId: "mock", modelId: "m" } },
      ],
      edges: [{ id: "a-b", source: "a", target: "b", targetHandle: "input" }],
    };
    const { outputs, levels } = await runGraph({ graph, run });
    expect(outputs["a"]).toBe("[mock:m] start");
    expect(outputs["b"]).toBe("[mock:m] next: [mock:m] start");
    expect(levels).toEqual([["a"], ["b"]]);
  });

  it("runs independent nodes in the same level", async () => {
    const { run } = makeRun();
    const graph: FlowGraph = {
      nodes: [
        { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "a", providerId: "mock", modelId: "m" } },
        { id: "b", type: "prompt", position: { x: 0, y: 1 }, data: { template: "b", providerId: "mock", modelId: "m" } },
      ],
      edges: [],
    };
    const { levels } = await runGraph({ graph, run });
    expect(levels).toHaveLength(1);
    expect(levels[0]).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("throws on a cycle", async () => {
    const { run } = makeRun();
    const graph: FlowGraph = {
      nodes: [
        { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "{{input}}", providerId: "mock", modelId: "m" } },
        { id: "b", type: "prompt", position: { x: 1, y: 0 }, data: { template: "{{input}}", providerId: "mock", modelId: "m" } },
      ],
      edges: [
        { id: "a-b", source: "a", target: "b", targetHandle: "input" },
        { id: "b-a", source: "b", target: "a", targetHandle: "input" },
      ],
    };
    await expect(runGraph({ graph, run })).rejects.toThrow(/cycle/);
  });
});
