import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("separates positional args from flags and options", () => {
    const parsed = parseArgs(["a.flow", "--check", "b.flow"]);
    expect(parsed.positional).toEqual(["a.flow", "b.flow"]);
    expect(parsed.flags.has("check")).toBe(true);
  });

  it("reads a declared option's value", () => {
    const parsed = parseArgs(["a.flow", "--out", "out.ts"], ["out"]);
    expect(parsed.options.get("out")).toBe("out.ts");
    expect(parsed.positional).toEqual(["a.flow"]);
  });

  it("throws when a declared option is missing its value", () => {
    expect(() => parseArgs(["--out"], ["out"])).toThrow(/requires a value/);
  });

  it("treats an undeclared --flag as a boolean flag, not an option", () => {
    const parsed = parseArgs(["--check", "a.flow"], ["out"]);
    expect(parsed.flags.has("check")).toBe(true);
    expect(parsed.positional).toEqual(["a.flow"]);
  });
});
