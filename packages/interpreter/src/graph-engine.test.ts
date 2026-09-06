import type { FlowGraph } from "@flowlathe/core";
import { MockProviderAdapter, SimpleScheduler } from "@flowlathe/providers";
import {
  createContextStore,
  createLlmConfigStore,
  createRun,
  createStateStore,
  createSuspendRegistry,
  InMemoryBlobStore,
} from "@flowlathe/runtime";
import { describe, expect, it } from "vitest";
import { GraphEngine } from "./run-graph.js";

function node(id: string, type: string, data: Record<string, unknown>) {
  return { id, type: type as never, position: { x: 0, y: 0 }, data };
}

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

function makeRun(): ReturnType<typeof createRun> {
  const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 8 } });
  return createRun({
    host: {
      scheduler,
      blobs: new InMemoryBlobStore(),
      emit: () => undefined,
      clock: { now: () => 0 },
      state: createStateStore(() => undefined, { decls: [] }),
      llmConfig: createLlmConfigStore(),
      context: createContextStore(),
      ...createSuspendRegistry(),
    },
  });
}

const chain: FlowGraph = {
  nodes: [node("a", "prompt", promptData("start")), node("b", "prompt", promptData("next: {{input}}"))],
  edges: [{ id: "a-b", source: "a", target: "b", targetHandle: "input" }],
  state: [],
};

describe("GraphEngine — stepping", () => {
  it("advances one node per step, in deterministic (topo-rank, then id) order", async () => {
    const engine = new GraphEngine(chain, makeRun());
    expect(engine.isDone()).toBe(false);

    const first = await engine.step();
    expect(first?.nodeId).toBe("a");
    expect(engine.isDone()).toBe(false);

    const second = await engine.step();
    expect(second?.nodeId).toBe("b");
    expect(engine.isDone()).toBe(true);

    const third = await engine.step();
    expect(third).toBeUndefined();

    expect(engine.collectOutputs()).toEqual({
      a: "[mock:m] start",
      b: "[mock:m] next: [mock:m] start",
    });
  });

  it("stepping to completion matches runToCompletion's result", async () => {
    const stepped = new GraphEngine(chain, makeRun());
    while (!stepped.isDone()) await stepped.step();

    const runResult = await new GraphEngine(chain, makeRun()).runToCompletion();
    expect(stepped.collectOutputs()).toEqual(runResult.outputs);
  });
});

describe("GraphEngine — snapshot/restore", () => {
  it("resuming from a snapshot after step 1 reproduces the same step 2 result", async () => {
    const engine = new GraphEngine(chain, makeRun());
    await engine.step(); // a
    const snapshot = engine.snapshot();
    expect(Object.keys(snapshot.outputs)).toEqual(["a"]);

    const resumed = GraphEngine.restore(chain, makeRun(), snapshot);
    expect(resumed.isDone()).toBe(false);
    const next = await resumed.step();
    expect(next?.nodeId).toBe("b");
    expect(resumed.collectOutputs()).toEqual({
      a: "[mock:m] start",
      b: "[mock:m] next: [mock:m] start",
    });
  });

  it("a restored engine forks independently — stepping it doesn't affect the original", async () => {
    const engine = new GraphEngine(chain, makeRun());
    await engine.step(); // a
    const snapshot = engine.snapshot();

    const forked = GraphEngine.restore(chain, makeRun(), snapshot);
    await forked.step(); // b, on the fork
    expect(forked.isDone()).toBe(true);

    // the original engine never advanced past step 1
    expect(engine.isDone()).toBe(false);
    expect(engine.collectOutputs()).toEqual({ a: "[mock:m] start" });
  });
});
