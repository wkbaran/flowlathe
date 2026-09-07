import { describe, expect, it } from "vitest";
import { asStringArray, clampLimit, PluginArgError, requireString } from "./args.js";

describe("requireString", () => {
  it("returns a present, non-blank string", () => {
    expect(requireString({ q: "hello" }, "q")).toBe("hello");
  });

  it("throws PluginArgError when missing", () => {
    expect(() => requireString({}, "q")).toThrow(PluginArgError);
  });

  it("throws PluginArgError when blank", () => {
    expect(() => requireString({ q: "   " }, "q")).toThrow(/missing required argument "q"/);
  });
});

describe("asStringArray", () => {
  it("passes a real array through, stringified", () => {
    expect(asStringArray(["a", "b"])).toEqual(["a", "b"]);
  });

  it("parses a JSON-array string", () => {
    expect(asStringArray('["a","b"]')).toEqual(["a", "b"]);
  });

  it("splits a comma-separated string", () => {
    expect(asStringArray("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for undefined/null/empty", () => {
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray(null)).toEqual([]);
    expect(asStringArray("")).toEqual([]);
  });

  it("falls back to comma-splitting on malformed JSON-looking input", () => {
    expect(asStringArray("[a, b")).toEqual(["[a", "b"]);
  });
});

describe("clampLimit", () => {
  it("uses the fallback for non-numeric input", () => {
    expect(clampLimit("nope", 20)).toBe(20);
  });

  it("clamps to the max", () => {
    expect(clampLimit(1000, 20, 50)).toBe(50);
  });

  it("clamps to a minimum of 1", () => {
    expect(clampLimit(-5, 20)).toBe(1);
  });

  it("truncates a fractional value", () => {
    expect(clampLimit(3.7, 20)).toBe(3);
  });
});
