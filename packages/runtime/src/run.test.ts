import type { RunEvent, RuntimeHost } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { createContextStore } from "./context-store.js";
import { createLlmConfigStore } from "./llm-config-store.js";
import { InMemoryBlobStore } from "./memory-blob-store.js";
import { createRun } from "./run.js";
import { createStateStore } from "./state-store.js";
import { createSuspendRegistry } from "./suspend-registry.js";
import { createToolRegistry, stateToolset } from "./tool-registry.js";

function testHost(): { host: RuntimeHost; events: RunEvent[] } {
  const events: RunEvent[] = [];
  const emit = (e: RunEvent): void => {
    events.push(e);
  };
  const state = createStateStore(emit, { decls: [] });
  const host: RuntimeHost = {
    scheduler: { submit: async (req) => ({ content: `echo:${req.prompt}`, finishReason: "stop" }) },
    blobs: new InMemoryBlobStore(),
    emit,
    clock: { now: () => 0 },
    state,
    llmConfig: createLlmConfigStore(),
    context: createContextStore(),
    tools: createToolRegistry(stateToolset(state)),
    net: { fetch: (() => { throw new Error("net not stubbed in this test"); }) as unknown as typeof fetch },
    ...createSuspendRegistry(),
  };
  return { host, events };
}

describe("createRun", () => {
  it("prompt() renders and executes a prompt node", async () => {
    const { host } = testHost();
    const rt = createRun({ host });
    const result = await rt.prompt(
      { id: "a", template: "hi {{x}}", providerId: "p", modelId: "m", enableStateTools: false, enabledToolsets: [] },
      { x: "y" },
    );
    expect(result.output).toBe("echo:hi y");
  });

  it("finish() emits a run_finished event carrying the final outputs", () => {
    const { host, events } = testHost();
    const rt = createRun({ host });
    rt.finish({ b: "done" });
    expect(events).toEqual([{ kind: "run_finished", outputs: { b: "done" } }]);
  });
});

describe("InMemoryBlobStore", () => {
  it("round-trips bytes by content hash", () => {
    const store = new InMemoryBlobStore();
    const sha = store.put(Buffer.from("hello"));
    expect(store.get(sha)).toEqual(Buffer.from("hello"));
  });
});
