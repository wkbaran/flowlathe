import type { FlowGraph, RunEvent } from "@flowlathe/core";
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
  const suspendRegistry = createSuspendRegistry();
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
      ...suspendRegistry,
    },
  });
  return { run, events, host: suspendRegistry };
}

const promptData = (template: string) => ({ template, providerId: "mock", modelId: "m" });

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
      ...createSuspendRegistry(),
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
        ...createSuspendRegistry(),
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
        ...createSuspendRegistry(),
      },
    });
    const { outputs } = await runGraph({ graph, run });
    expect(outputs["l"]).toBe("3");
  });

  it("a loop body's conversation memory accumulates by static node id, not its scoped activation key", async () => {
    const contextStore = createContextStore();
    const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 8 } });
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
        ...createSuspendRegistry(),
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
