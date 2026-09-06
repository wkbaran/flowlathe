import { describe, expect, it } from "vitest";
import { createContextStore } from "./context-store.js";

describe("createContextStore", () => {
  it("returns an empty array for a node with no history", () => {
    expect(createContextStore().get("a")).toEqual([]);
  });

  it("append accumulates turns per node, independently of other nodes", () => {
    const store = createContextStore();
    store.append("a", [{ role: "user", content: "hi" }]);
    store.append("a", [{ role: "assistant", content: "hello" }]);
    store.append("b", [{ role: "user", content: "unrelated" }]);
    expect(store.get("a")).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(store.get("b")).toEqual([{ role: "user", content: "unrelated" }]);
  });

  it("replace overwrites a node's history wholesale (how compaction applies)", () => {
    const store = createContextStore();
    store.append("a", [{ role: "user", content: "one" }, { role: "assistant", content: "two" }]);
    store.replace("a", [{ role: "system", content: "summary" }]);
    expect(store.get("a")).toEqual([{ role: "system", content: "summary" }]);
  });
});
