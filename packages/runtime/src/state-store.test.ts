import type { RunEvent } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { createStateStore } from "./state-store.js";

function collect() {
  const events: RunEvent[] = [];
  return { events, emit: (e: RunEvent) => events.push(e) };
}

describe("createStateStore", () => {
  it("seeds declared initial values and applies each entry's merge rule on write", () => {
    const { emit } = collect();
    const store = createStateStore(emit, {
      decls: [
        { name: "findings", type: "array", merge: "append", initial: [] },
        { name: "count", type: "number", merge: "numeric-add" },
      ],
    });
    store.write("findings", "a");
    store.write("findings", "b");
    store.write("count", 3);
    store.write("count", 4);
    expect(store.read("findings")).toEqual(["a", "b"]);
    expect(store.read("count")).toBe(7);
  });

  it("rejects writes to an undeclared entry", () => {
    const { emit } = collect();
    const store = createStateStore(emit, { decls: [] });
    expect(() => store.write("nope", 1)).toThrow(/unknown state entry/);
  });

  it("emits state_write/state_read events carrying viaTool and the write's seq", () => {
    const { events, emit } = collect();
    const store = createStateStore(emit, { decls: [{ name: "x", type: "string", merge: "replace" }] });
    store.write("x", "hello", { viaTool: true, activationKey: "node-1" });
    store.read("x", { viaTool: true, activationKey: "node-2" });
    expect(events).toEqual([
      { kind: "state_write", entry: "x", value: "hello", merge: "replace", seq: 1, viaTool: true, activationKey: "node-1" },
      { kind: "state_read", entry: "x", seqSeen: 1, viaTool: true, activationKey: "node-2" },
    ]);
  });

  it("resumes from a replay log, continuing the seq counter", () => {
    const { emit } = collect();
    const store = createStateStore(emit, {
      decls: [{ name: "x", type: "string", merge: "replace" }],
      replay: [
        { entry: "x", value: "first", seq: 1 },
        { entry: "x", value: "second", seq: 2 },
      ],
    });
    expect(store.read("x")).toBe("second");
    store.write("x", "third");
    expect(store.read("x")).toBe("third");
  });

  it("error-on-conflict throws when a second writer disagrees", () => {
    const { emit } = collect();
    const store = createStateStore(emit, { decls: [{ name: "x", type: "string", merge: "error-on-conflict" }] });
    store.write("x", "a");
    expect(() => store.write("x", "b")).toThrow(/conflict/);
    store.write("x", "a"); // agreeing writes never conflict
  });
});
