import { createRunControl, type FlowGraph, type RunEvent } from "@flowlathe/core";
import { MockProviderAdapter, SimpleScheduler } from "@flowlathe/providers";
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
import { describe, expect, it } from "vitest";
import { runGraph } from "./run-graph.js";

function node(id: string, type: string, data: Record<string, unknown>, parentId?: string) {
  return { id, type: type as never, position: { x: 0, y: 0 }, data, ...(parentId ? { parentId } : {}) };
}

function noopState() {
  return createStateStore(() => undefined, { decls: [] });
}

function makeRun(): { run: ReturnType<typeof createRun>; events: RunEvent[]; host: ReturnType<typeof createSuspendRegistry> } {
  const events: RunEvent[] = [];
  const emit = (e: RunEvent): void => {
    events.push(e);
  };
  const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 8 } });
  const cancellation = createRunControl();
  const suspendRegistry = createSuspendRegistry(cancellation);
  const state = createStateStore(emit, { decls: [] });
  const run = createRun({
    host: {
      scheduler,
      blobs: new InMemoryBlobStore(),
      emit,
      clock: { now: () => 0 },
      state,
      llmConfig: createLlmConfigStore(),
      context: createContextStore(),
      tools: createToolRegistry(stateToolset(state)),
      cancellation,
      net: { fetch: (() => { throw new Error("net not stubbed in this test"); }) as unknown as typeof fetch },
      ...suspendRegistry,
    },
  });
  return { run, events, host: suspendRegistry };
}

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

const mapData = (itemPortName: string, overrides: Record<string, unknown> = {}) => ({
  itemsTemplate: '["x","y"]',
  itemPortName,
  maxConcurrency: 2,
  maxItems: 10,
  ...overrides,
});

describe("runGraph — linear chains", () => {
  it("feeds node A's output into node B's template", async () => {
    const { run } = makeRun();
    const graph: FlowGraph = {
      nodes: [node("a", "prompt", promptData("start")), node("b", "prompt", promptData("next: {{input}}"))],
      edges: [{ id: "a-b", source: "a", target: "b", targetHandle: "input" }],
      state: [],
    };
    const { outputs } = await runGraph({ graph, run });
    expect(outputs["a"]).toBe("[mock:m] start");
    expect(outputs["b"]).toBe("[mock:m] next: [mock:m] start");
  });

  it("throws on a cycle", async () => {
    const { run } = makeRun();
    const graph: FlowGraph = {
      nodes: [node("a", "prompt", promptData("{{input}}")), node("b", "prompt", promptData("{{input}}"))],
      edges: [
        { id: "a-b", source: "a", target: "b", targetHandle: "input" },
        { id: "b-a", source: "b", target: "a", targetHandle: "input" },
      ],
      state: [],
    };
    await expect(runGraph({ graph, run })).rejects.toThrow(/cycle/);
  });
});

function identityRun(events: RunEvent[] = []): ReturnType<typeof createRun> {
  const scheduler = new SimpleScheduler({
    mock: { adapter: { kind: "identity", call: async (req: { prompt: string }) => ({ content: req.prompt, finishReason: "stop" }) }, maxParallel: 8 },
  });
  const state = noopState();
  const cancellation = createRunControl();
  return createRun({
    host: {
      scheduler,
      blobs: new InMemoryBlobStore(),
      emit: (e) => events.push(e),
      clock: { now: () => 0 },
      state,
      llmConfig: createLlmConfigStore(),
      context: createContextStore(),
      tools: createToolRegistry(stateToolset(state)),
      cancellation,
      net: { fetch: (() => { throw new Error("net not stubbed in this test"); }) as unknown as typeof fetch },
      ...createSuspendRegistry(cancellation),
    },
  });
}

describe("runGraph — router + merge (fan-out/join)", () => {
  function diamondGraph(seedInput: string): FlowGraph {
    return {
      nodes: [
        node("seed", "prompt", promptData(seedInput)),
        node("router", "router", {
          routes: ["code", "prose"],
          cases: [
            { value: "code", route: "code" },
            { value: "prose", route: "prose" },
          ],
        }),
        node("codeAnswer", "prompt", promptData("CODE: {{q}}")),
        node("proseAnswer", "prompt", promptData("PROSE: {{q}}")),
        node("merge", "merge", {}),
      ],
      edges: [
        { id: "e0", source: "seed", target: "router", targetHandle: "input" },
        { id: "e1", source: "router", target: "codeAnswer", sourceHandle: "code", targetHandle: "q" },
        { id: "e2", source: "router", target: "proseAnswer", sourceHandle: "prose", targetHandle: "q" },
        { id: "e3", source: "codeAnswer", target: "merge", targetHandle: "in1" },
        { id: "e4", source: "proseAnswer", target: "merge", targetHandle: "in2" },
      ],
      state: [],
    };
  }

  it("runs only the taken branch and propagates never on the other", async () => {
    const { outputs } = await runGraph({ graph: diamondGraph("code"), run: identityRun() });
    expect(outputs["codeAnswer"]).toBe("CODE: code");
    expect(outputs["proseAnswer"]).toBeUndefined();
    expect(outputs["merge"]).toBe("CODE: code");
  });

  it("takes the other branch just as well, still joining correctly", async () => {
    const { outputs } = await runGraph({ graph: diamondGraph("prose"), run: identityRun() });
    expect(outputs["proseAnswer"]).toBe("PROSE: prose");
    expect(outputs["codeAnswer"]).toBeUndefined();
    expect(outputs["merge"]).toBe("PROSE: prose");
  });

  it("skips a node whose only required input traces to the never branch", async () => {
    const graph: FlowGraph = {
      nodes: [
        node("seed", "prompt", promptData("neither")),
        node("router", "router", { routes: ["a", "b"], cases: [{ value: "a", route: "a" }], defaultRoute: "b" }),
        node("onlyIfA", "prompt", promptData("got: {{x}}")),
      ],
      edges: [
        { id: "e0", source: "seed", target: "router", targetHandle: "input" },
        { id: "e1", source: "router", target: "onlyIfA", sourceHandle: "a", targetHandle: "x" },
      ],
      state: [],
    };
    const events: RunEvent[] = [];
    const { outputs } = await runGraph({ graph, run: identityRun(events) });
    // "neither" doesn't match case "a" -> defaultRoute "b" taken -> onlyIfA's port stays never -> skipped
    expect(outputs["onlyIfA"]).toBeUndefined();
    expect(events).toContainEqual({ kind: "node_skipped", nodeId: "onlyIfA", reason: "upstream_skipped" });
  });
});

describe("runGraph — fan-out concurrency", () => {
  it("dispatches independent nodes concurrently, not sequentially", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseAll: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const adapter = {
      kind: "gated",
      call: async (req: { nodeId: string; prompt: string }) => {
        started.push(req.nodeId);
        if (started.length === 3) releaseAll?.();
        await gate;
        finished.push(req.nodeId);
        return { content: `${req.nodeId}-done`, finishReason: "stop" };
      },
    };
    const scheduler = new SimpleScheduler({ mock: { adapter, maxParallel: 8 } });
    const cancellation = createRunControl();
    const run = createRun({
      host: {
        scheduler,
        blobs: new InMemoryBlobStore(),
        emit: () => undefined,
        clock: { now: () => 0 },
        state: noopState(),
        llmConfig: createLlmConfigStore(),
        context: createContextStore(),
        tools: createToolRegistry(stateToolset(noopState())),
        cancellation,
        net: { fetch: (() => { throw new Error("net not stubbed in this test"); }) as unknown as typeof fetch },
        ...createSuspendRegistry(cancellation),
      },
    });

    const graph: FlowGraph = {
      nodes: [
        node("a", "prompt", promptData("a")),
        node("b", "prompt", promptData("b")),
        node("c", "prompt", promptData("c")),
        node("join", "merge", {}),
      ],
      edges: [
        { id: "e1", source: "a", target: "join", targetHandle: "in1" },
        { id: "e2", source: "b", target: "join", targetHandle: "in2" },
      ],
      state: [],
    };
    const { outputs } = await runGraph({ graph, run });
    // all 3 must have STARTED before any of them finished -> genuine concurrency, not serial
    expect(started.sort()).toEqual(["a", "b", "c"]);
    expect(finished).toHaveLength(3);
    expect(outputs["a"]).toBe("a-done");
  });
});

describe("runGraph — cancellation (PLAN-CANCELLATION.md D1)", () => {
  function runWithAdapter(adapter: { kind: string; call: (req: { nodeId: string; prompt: string }) => Promise<{ content: string; finishReason: string }> }) {
    const scheduler = new SimpleScheduler({ mock: { adapter, maxParallel: 8 } });
    const cancellation = createRunControl();
    return createRun({
      host: {
        scheduler,
        blobs: new InMemoryBlobStore(),
        emit: () => undefined,
        clock: { now: () => 0 },
        state: noopState(),
        llmConfig: createLlmConfigStore(),
        context: createContextStore(),
        tools: createToolRegistry(stateToolset(noopState())),
        cancellation,
        net: { fetch: (() => { throw new Error("net not stubbed in this test"); }) as unknown as typeof fetch },
        ...createSuspendRegistry(cancellation),
      },
    });
  }

  it("drains the in-flight sibling before rejecting — nothing settles after the reject", async () => {
    const order: string[] = [];
    let releaseB: (() => void) | undefined;
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    const run = runWithAdapter({
      kind: "custom",
      call: async (req) => {
        if (req.nodeId === "boom") throw new Error("boom");
        await bGate;
        order.push("b-settled");
        return { content: "b-done", finishReason: "stop" };
      },
    });
    const graph: FlowGraph = {
      nodes: [node("boom", "prompt", promptData("x")), node("b", "prompt", promptData("y"))],
      edges: [],
      state: [],
    };

    const resultPromise = runGraph({ graph, run });
    resultPromise.catch(() => order.push("rejected"));
    await new Promise((r) => setImmediate(r));
    releaseB?.();
    await expect(resultPromise).rejects.toThrow("boom");
    expect(order).toEqual(["b-settled", "rejected"]);
  });

  it(
    "rejects rather than hanging when the surviving sibling is parked in a suspend",
    async () => {
      let releaseBoom: (() => void) | undefined;
      const boomGate = new Promise<void>((resolve) => {
        releaseBoom = resolve;
      });
      const run = runWithAdapter({
        kind: "custom",
        call: async (req) => {
          if (req.nodeId === "boom") {
            await boomGate;
            throw new Error("boom");
          }
          return { content: "seed-done", finishReason: "stop" };
        },
      });
      // "seed" feeds "p"'s required input port so "p" gets admitted (and parks itself in
      // ctx.suspend) independently of "boom" — held back by `boomGate` until "p" is safely
      // parked, so this test doesn't race on microtask ordering between the two.
      const graph: FlowGraph = {
        nodes: [node("boom", "prompt", promptData("x")), node("seed", "prompt", promptData("y")), node("p", "pause", { message: "hold" })],
        edges: [{ id: "e1", source: "seed", target: "p", targetHandle: "input" }],
        state: [],
      };

      const resultPromise = runGraph({ graph, run });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      releaseBoom?.();
      await expect(resultPromise).rejects.toThrow("boom");
    },
    5_000,
  );
});

describe("runGraph — pause / user input suspend-resume", () => {
  it("suspends a Pause node and resumes it with the passthrough value", async () => {
    const { run, host } = makeRun();
    const graph: FlowGraph = {
      nodes: [node("a", "prompt", promptData("start")), node("p", "pause", { message: "hold" })],
      edges: [{ id: "e1", source: "a", target: "p", targetHandle: "input" }],
      state: [],
    };
    const resultPromise = runGraph({ graph, run });
    await new Promise((r) => setImmediate(r));
    host.resolveSuspended("p", "");
    const { outputs } = await resultPromise;
    expect(outputs["p"]).toBe("[mock:m] start");
  });

  it("suspends a UserInput node and resumes it with the human's answer", async () => {
    const { run, host } = makeRun();
    const graph: FlowGraph = {
      nodes: [node("u", "userInput", { prompt: "What's your name?" })],
      edges: [],
      state: [],
    };
    const resultPromise = runGraph({ graph, run });
    await new Promise((r) => setImmediate(r));
    host.resolveSuspended("u", "Ada");
    const { outputs } = await resultPromise;
    expect(outputs["u"]).toBe("Ada");
  });
});

describe("runGraph — loop", () => {
  it("threads the accumulator until it hits stopValue", async () => {
    const graph: FlowGraph = {
      nodes: [
        node("l", "loop", { initTemplate: "0", accPortName: "acc", stopValue: "3", maxIterations: 10 }),
        node("body", "prompt", promptData("{{acc}}"), "l"),
      ],
      edges: [],
      state: [],
    };
    // the shared mock adapter prefixes "[mock:m] ", which would never converge on a numeric
    // stopValue -- use a custom incrementing adapter instead so the loop can actually terminate.
    // Each call's own conversation memory prefixes prior turns onto the prompt, so pull out just
    // the trailing number rather than assuming the whole prompt is numeric.
    const scheduler = new SimpleScheduler({
      mock: {
        adapter: {
          kind: "incrementer",
          call: async (req: { prompt: string }) => {
            const match = req.prompt.match(/(\d+)\s*$/);
            return { content: String(Number(match?.[1] ?? "0") + 1), finishReason: "stop" };
          },
        },
        maxParallel: 8,
      },
    });
    const cancellation = createRunControl();
    const run = createRun({
      host: {
        scheduler,
        blobs: new InMemoryBlobStore(),
        emit: () => undefined,
        clock: { now: () => 0 },
        state: noopState(),
        llmConfig: createLlmConfigStore(),
        context: createContextStore(),
        tools: createToolRegistry(stateToolset(noopState())),
        cancellation,
        net: { fetch: (() => { throw new Error("net not stubbed in this test"); }) as unknown as typeof fetch },
        ...createSuspendRegistry(cancellation),
      },
    });
    const { outputs } = await runGraph({ graph, run });
    expect(outputs["l"]).toBe("3");
  });

  it("a loop body's conversation memory accumulates by static node id, not its scoped activation key", async () => {
    const contextStore = createContextStore();
    const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 8 } });
    const cancellation = createRunControl();
    const runWithContext = createRun({
      host: {
        scheduler,
        blobs: new InMemoryBlobStore(),
        emit: () => undefined,
        clock: { now: () => 0 },
        state: noopState(),
        llmConfig: createLlmConfigStore(),
        context: contextStore,
        tools: createToolRegistry(stateToolset(noopState())),
        cancellation,
        net: { fetch: (() => { throw new Error("net not stubbed in this test"); }) as unknown as typeof fetch },
        ...createSuspendRegistry(cancellation),
      },
    });
    const graph: FlowGraph = {
      nodes: [
        node("l", "loop", { initTemplate: "0", accPortName: "acc", stopValue: "STOP", maxIterations: 3 }),
        node("body", "prompt", promptData("{{acc}}"), "l"),
      ],
      edges: [],
      state: [],
    };
    // stopValue is unreachable (the mock always prefixes "[mock:m] "), so the loop runs all 3
    // iterations and then raises -- exactly what exercises 3 body dispatches for this assertion.
    await expect(runGraph({ graph, run: runWithContext })).rejects.toThrow(/maxIterations/);
    // 3 iterations x 2 turns (user+assistant) each, all under the one static "body" key
    expect(contextStore.get("body")).toHaveLength(6);
    expect(contextStore.get("body@l:0")).toEqual([]);
  });

  it("raises when it never reaches stopValue within maxIterations", async () => {
    const { run } = makeRun();
    const graph: FlowGraph = {
      nodes: [
        node("l", "loop", { initTemplate: "0", accPortName: "acc", stopValue: "never", maxIterations: 2 }),
        node("body", "prompt", promptData("{{acc}}"), "l"),
      ],
      edges: [],
      state: [],
    };
    await expect(runGraph({ graph, run })).rejects.toThrow(/maxIterations/);
  });
});

describe("runGraph — map", () => {
  it("fans out over items concurrently and joins results in input order", async () => {
    const { run } = makeRun();
    const graph: FlowGraph = {
      nodes: [
        node("m", "map", { itemsTemplate: '["x","y","z"]', itemPortName: "item", maxConcurrency: 3, maxItems: 10 }),
        node("body", "prompt", promptData("got: {{item}}"), "m"),
      ],
      edges: [],
      state: [],
    };
    const { outputs } = await runGraph({ graph, run });
    expect(JSON.parse(outputs["m"]!)).toEqual([
      "[mock:m] got: x",
      "[mock:m] got: y",
      "[mock:m] got: z",
    ]);
  });
});

describe("runGraph — multi-node (subgraph) bodies", () => {
  it("map with a 2-node chain body dispatches both nodes per iteration under scoped keys", async () => {
    const { run, events } = makeRun();
    const graph: FlowGraph = {
      nodes: [
        node("m", "map", { itemsTemplate: '["x","y"]', itemPortName: "item", maxConcurrency: 2, maxItems: 10 }),
        node("a", "prompt", promptData("{{item}}"), "m"),
        node("b", "prompt", promptData("next: {{input}}"), "m"),
      ],
      edges: [{ id: "a-b", source: "a", target: "b", targetHandle: "input" }],
      state: [],
    };
    const { outputs } = await runGraph({ graph, run });
    expect(JSON.parse(outputs["m"]!)).toEqual([
      "[mock:m] next: [mock:m] x",
      "[mock:m] next: [mock:m] y",
    ]);
    const startedIds = events
      .flatMap((e) => (e.kind === "node_started" && e.nodeId.includes("@") ? [e.nodeId] : []))
      .sort();
    expect(startedIds).toEqual(["a@m:0", "a@m:1", "b@m:0", "b@m:1"]);
  });

  it("loop with a router+merge body: branch pruning works inside an iteration", async () => {
    const { run, events } = makeRun();
    const graph: FlowGraph = {
      nodes: [
        node("l", "loop", {
          initTemplate: "seed",
          accPortName: "input",
          stopValue: "[mock:m] X:seed",
          maxIterations: 3,
        }),
        node("r", "router", { routes: ["x", "y"], cases: [{ value: "seed", route: "x" }], defaultRoute: "y" }, "l"),
        node("x", "prompt", promptData("X:{{input}}"), "l"),
        node("y", "prompt", promptData("Y:{{input}}"), "l"),
        node("merge", "merge", {}, "l"),
      ],
      edges: [
        { id: "e1", source: "r", target: "x", sourceHandle: "x", targetHandle: "input" },
        { id: "e2", source: "r", target: "y", sourceHandle: "y", targetHandle: "input" },
        { id: "e3", source: "x", target: "merge", targetHandle: "in1" },
        { id: "e4", source: "y", target: "merge", targetHandle: "in2" },
      ],
      state: [],
    };
    const { outputs } = await runGraph({ graph, run });
    expect(outputs["l"]).toBe("[mock:m] X:seed");
    const skipped = events.filter((e) => e.kind === "node_skipped");
    expect(skipped).toEqual([{ kind: "node_skipped", nodeId: "y@l:0", reason: "upstream_skipped" }]);
  });

  it("map-of-loop nesting produces a /-joined scoped activation key", async () => {
    const { run, events } = makeRun();
    const graph: FlowGraph = {
      nodes: [
        node("m", "map", mapData("item", { itemsTemplate: '["a","b"]' })),
        node("l", "loop", { initTemplate: "{{item}}", accPortName: "acc", stopValue: "unreachable", maxIterations: 1 }, "m"),
        node("body2", "prompt", promptData("{{acc}}"), "l"),
      ],
      edges: [],
      state: [],
    };
    await expect(runGraph({ graph, run })).rejects.toThrow(/maxIterations/);
    const startedIds = events.flatMap((e) => (e.kind === "node_started" ? [e.nodeId] : []));
    expect(startedIds).toContain("body2@m:0/l:0");
    expect(startedIds).toContain("body2@m:1/l:0");
  });

  it("each of R3/R4/R5/R6/R7 is caught by validation before any node dispatches", async () => {
    const { run: r1 } = makeRun();
    await expect(
      runGraph({
        graph: { nodes: [node("m", "map", mapData("item"))], edges: [], state: [] },
        run: r1,
      }),
    ).rejects.toThrow(/invalid flow graph.*no body node/);

    const { run: r2, events: e2 } = makeRun();
    await expect(
      runGraph({
        graph: {
          nodes: [node("m", "map", mapData("item")), node("outer", "prompt", promptData("hi")), node("a", "prompt", promptData("{{item}}"), "m")],
          edges: [{ id: "e1", source: "outer", target: "a", targetHandle: "item" }],
          state: [],
        },
        run: r2,
      }),
    ).rejects.toThrow(/invalid flow graph.*crosses into a Loop\/Map body/);
    expect(e2).toEqual([]);

    const { run: r3 } = makeRun();
    await expect(
      runGraph({
        graph: {
          nodes: [node("m", "map", mapData("item")), node("a", "prompt", promptData("{{item}}"), "m"), node("b", "prompt", promptData("{{input}}"), "m")],
          edges: [
            { id: "e1", source: "a", target: "b", targetHandle: "input" },
            { id: "e2", source: "b", target: "a", targetHandle: "item" },
          ],
          state: [],
        },
        run: r3,
      }),
    ).rejects.toThrow(/invalid flow graph.*contains a cycle/);

    const { run: r4 } = makeRun();
    await expect(
      runGraph({
        graph: {
          nodes: [
            node("m", "map", mapData("item")),
            node("a", "prompt", promptData("{{item}}"), "m"),
            node("b", "prompt", promptData("{{item}}"), "m"),
          ],
          edges: [],
          state: [],
        },
        run: r4,
      }),
    ).rejects.toThrow(/invalid flow graph.*more than one terminal node/);

    const { run: r5 } = makeRun();
    await expect(
      runGraph({
        graph: { nodes: [node("m", "map", mapData("item")), node("a", "prompt", promptData("hi"), "m")], edges: [], state: [] },
        run: r5,
      }),
    ).rejects.toThrow(/invalid flow graph.*no node declaring input port "item"/);

    const { run: r6 } = makeRun();
    await expect(
      runGraph({
        graph: {
          nodes: [node("m", "map", mapData("item")), node("a", "prompt", promptData("{{item}} {{extra}}"), "m")],
          edges: [],
          state: [],
        },
        run: r6,
      }),
    ).rejects.toThrow(/invalid flow graph.*declares input port "extra" with no incoming edge/);
  });
});

describe("runGraph — missing plugin dependency gate", () => {
  it("throws before any node dispatches when a node requires an unregistered toolset", async () => {
    const { run } = makeRun();
    const graph: FlowGraph = {
      nodes: [node("a", "prompt", { ...promptData("hi"), enabledToolsets: ["spotify"] })],
      edges: [],
      state: [],
    };
    await expect(runGraph({ graph, run })).rejects.toThrow(/missing required plugin.*spotify/);
  });

  it("does not throw when the graph requires nothing", async () => {
    const { run } = makeRun();
    const graph: FlowGraph = {
      nodes: [node("a", "prompt", promptData("hi"))],
      edges: [],
      state: [],
    };
    await expect(runGraph({ graph, run })).resolves.toBeDefined();
  });

  it("does not throw when the required toolset is actually registered", async () => {
    const { run } = makeRun();
    const graph: FlowGraph = {
      nodes: [node("a", "prompt", { ...promptData("hi"), enabledToolsets: ["state"] })],
      edges: [],
      state: [],
    };
    await expect(runGraph({ graph, run })).resolves.toBeDefined();
  });
});

describe("runGraph — seed (trigger nodes)", () => {
  it("uses the seeded value instead of dispatching (testPayload never appears)", async () => {
    const { run, events } = makeRun();
    const graph: FlowGraph = {
      nodes: [
        node("t", "trigger", { source: "discord", testPayload: "SHOULD_NOT_APPEAR" }),
        node("b", "prompt", promptData("got: {{input}}")),
      ],
      edges: [{ id: "t-b", source: "t", target: "b", sourceHandle: "content", targetHandle: "input" }],
      state: [],
    };
    const { outputs } = await runGraph({
      graph,
      run,
      seed: { t: { content: "REAL_MESSAGE", authorId: "u1", channelId: "c1", messageId: "m1" } },
    });
    expect(outputs["b"]).toBe("[mock:m] got: REAL_MESSAGE");
    // the trigger node itself never dispatches when seeded, so it emits no node_started/finished.
    expect(events.some((e) => "nodeId" in e && e.nodeId === "t")).toBe(false);
  });

  it("falls back to testPayload when not seeded (canvas run)", async () => {
    const { run } = makeRun();
    const graph: FlowGraph = {
      nodes: [node("t", "trigger", { source: "manual", testPayload: "FROM_THE_DESK" }), node("b", "prompt", promptData("got: {{input}}"))],
      edges: [{ id: "t-b", source: "t", target: "b", sourceHandle: "content", targetHandle: "input" }],
      state: [],
    };
    const { outputs } = await runGraph({ graph, run });
    expect(outputs["b"]).toBe("[mock:m] got: FROM_THE_DESK");
  });
});
