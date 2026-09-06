import { describe, expect, it } from "vitest";
import { createStateStore } from "./state-store.js";
import { createToolRegistry, stateToolset } from "./tool-registry.js";

describe("createToolRegistry", () => {
  it("returns only the specs for requested toolsets", () => {
    const registry = createToolRegistry([
      { toolset: "a", spec: spec("tool_a"), handler: () => "a" },
      { toolset: "b", spec: spec("tool_b"), handler: () => "b" },
    ]);
    expect(registry.specsFor(["a"]).map((s) => s.name)).toEqual(["tool_a"]);
    expect(registry.specsFor(["a", "b"]).map((s) => s.name)).toEqual(["tool_a", "tool_b"]);
    expect(registry.specsFor([])).toEqual([]);
    expect(registry.specsFor(["nope"])).toEqual([]);
  });

  it("invokes the matching handler with args and meta", async () => {
    const seen: unknown[] = [];
    const registry = createToolRegistry([
      {
        toolset: "a",
        spec: spec("echo"),
        handler: (args, meta) => {
          seen.push([args, meta]);
          return `got ${JSON.stringify(args)}`;
        },
      },
    ]);
    const result = await registry.invoke("echo", { x: 1 }, { activationKey: "node-1" });
    expect(result).toBe('got {"x":1}');
    expect(seen).toEqual([[{ x: 1 }, { activationKey: "node-1" }]]);
  });

  it("returns an error string for an unknown tool name rather than throwing", async () => {
    const registry = createToolRegistry([]);
    const result = await registry.invoke("nonexistent", {}, { activationKey: "node-1" });
    expect(result).toBe("[nonexistent]: error - unknown tool");
  });

  it("catches a handler that throws and returns an error string instead of rejecting", async () => {
    const registry = createToolRegistry([
      {
        toolset: "a",
        spec: spec("boom"),
        handler: () => {
          throw new Error("kaboom");
        },
      },
    ]);
    const result = await registry.invoke("boom", {}, { activationKey: "node-1" });
    expect(result).toBe("[boom]: error - kaboom");
  });
});

describe("stateToolset", () => {
  it("read_state and write_state route through the given StateStore, tagged viaTool", async () => {
    const events: unknown[] = [];
    const state = createStateStore((e) => events.push(e), {
      decls: [{ name: "notes", type: "string", merge: "append" }],
    });
    const registry = createToolRegistry(stateToolset(state));

    const writeResult = await registry.invoke(
      "write_state",
      { entry: "notes", value: "hello" },
      { activationKey: "node-1" },
    );
    expect(writeResult).toBe("[write_state notes]: ok");

    const readResult = await registry.invoke("read_state", { entry: "notes" }, { activationKey: "node-1" });
    expect(readResult).toBe('[read_state notes]: ["hello"]');

    expect(events).toContainEqual(expect.objectContaining({ kind: "state_write", viaTool: true }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "state_read", viaTool: true }));
  });
});

function spec(name: string) {
  return { name, description: name, parameters: { type: "object" as const, properties: {} } };
}
