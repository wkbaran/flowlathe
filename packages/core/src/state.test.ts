import { describe, expect, it } from "vitest";
import { applyMerge, StateWriteConflict } from "./state.js";

describe("applyMerge", () => {
  it("replace always takes the incoming value", () => {
    expect(applyMerge("replace", "old", "new")).toBe("new");
  });

  it("append accumulates into an array regardless of previous shape", () => {
    expect(applyMerge("append", undefined, "a")).toEqual(["a"]);
    expect(applyMerge("append", ["a"], "b")).toEqual(["a", "b"]);
  });

  it("numeric-add sums, treating a missing previous value as 0", () => {
    expect(applyMerge("numeric-add", undefined, 3)).toBe(3);
    expect(applyMerge("numeric-add", 3, 4)).toBe(7);
  });

  it("numeric-add rejects a non-numeric incoming value", () => {
    expect(() => applyMerge("numeric-add", 1, "not a number")).toThrow(/not a number/);
  });

  it("set-union de-duplicates across previous and incoming", () => {
    expect(applyMerge("set-union", ["a", "b"], "b")).toEqual(["a", "b"]);
    expect(applyMerge("set-union", undefined, ["a", "a"])).toEqual(["a"]);
  });

  it("error-on-conflict passes through agreeing writes and throws on disagreement", () => {
    expect(applyMerge("error-on-conflict", undefined, "x")).toBe("x");
    expect(applyMerge("error-on-conflict", "x", "x")).toBe("x");
    expect(() => applyMerge("error-on-conflict", "x", "y", "myEntry")).toThrow(StateWriteConflict);
  });
});
