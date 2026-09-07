import { describe, expect, it } from "vitest";
import { slugify, uniqueSlug } from "./slug.js";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Research Brief")).toBe("research-brief");
  });

  it("strips leading/trailing punctuation", () => {
    expect(slugify("  --Hello, World!--  ")).toBe("hello-world");
  });

  it("falls back to a generic name for an all-punctuation input", () => {
    expect(slugify("###")).toBe("flow");
  });
});

describe("uniqueSlug", () => {
  it("suffixes on collision", () => {
    const taken = new Set<string>();
    const a = uniqueSlug("extract", taken);
    taken.add(a);
    const b = uniqueSlug("extract", taken);
    taken.add(b);
    const c = uniqueSlug("extract", taken);
    expect([a, b, c]).toEqual(["extract", "extract-2", "extract-3"]);
  });
});
