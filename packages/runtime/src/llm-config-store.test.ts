import { describe, expect, it } from "vitest";
import { createLlmConfigStore } from "./llm-config-store.js";

describe("createLlmConfigStore", () => {
  it("starts empty", () => {
    expect(createLlmConfigStore().get()).toEqual({});
  });

  it("shallow-merges successive patches", () => {
    const store = createLlmConfigStore();
    store.set({ temperature: 0.5 });
    store.set({ topK: 40 });
    expect(store.get()).toEqual({ temperature: 0.5, topK: 40 });
  });

  it("a later patch overwrites a field a prior patch set", () => {
    const store = createLlmConfigStore();
    store.set({ temperature: 0.5 });
    store.set({ temperature: 0.9 });
    expect(store.get()).toEqual({ temperature: 0.9 });
  });
});
