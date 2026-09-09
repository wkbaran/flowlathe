import { describe, expect, it } from "vitest";
import { gitRefSlot, intSlot, repoSlugSlot, SlotError, textSlot } from "./slot-safety.js";

describe("gitRefSlot", () => {
  it.each(["main", "feature/x", "a".repeat(40), "v1.2.3"])("accepts %s", (value) => {
    expect(gitRefSlot(value, "ref")).toBe(value);
  });

  it.each([
    "-o",
    "--upload-pack",
    "a/../../b",
    "/leading",
    "trailing/",
    "a//b",
    "has space",
    "a^b",
    "a:b",
    "x.lock",
    "",
    "a".repeat(256),
    "a\0b",
  ])("rejects %s", (value) => {
    expect(() => gitRefSlot(value, "ref")).toThrow(SlotError);
  });
});

describe("repoSlugSlot", () => {
  it("accepts owner/name", () => {
    expect(repoSlugSlot("owner/name", "repo")).toEqual({ owner: "owner", name: "name", slug: "owner/name" });
  });

  it("accepts Owner.Name/repo-1", () => {
    expect(repoSlugSlot("Owner.Name/repo-1", "repo")).toEqual({
      owner: "Owner.Name",
      name: "repo-1",
      slug: "Owner.Name/repo-1",
    });
  });

  it.each(["owner", "a/b/c", "../x", "owner/", "/name", "-owner/name", `owner/${"a".repeat(101)}`])(
    "rejects %s",
    (value) => {
      expect(() => repoSlugSlot(value, "repo")).toThrow(SlotError);
    },
  );
});

describe("intSlot", () => {
  it("returns an in-range integer", () => {
    expect(intSlot(5, "count", 1, 10)).toBe(5);
  });

  it("accepts a numeric string", () => {
    expect(intSlot("5", "count", 1, 10)).toBe(5);
  });

  it("throws rather than clamps when out of range", () => {
    expect(() => intSlot(1000, "count", 1, 10)).toThrow(SlotError);
    expect(() => intSlot(-1, "count", 1, 10)).toThrow(SlotError);
  });

  it("throws on a non-integer", () => {
    expect(() => intSlot(3.7, "count", 1, 10)).toThrow(SlotError);
    expect(() => intSlot("nope", "count", 1, 10)).toThrow(SlotError);
  });
});

describe("textSlot", () => {
  it("keeps newlines and tabs", () => {
    expect(textSlot("line one\n\tindented", "body", 100)).toBe("line one\n\tindented");
  });

  it("rejects NUL and other control characters", () => {
    expect(() => textSlot("a\0b", "body", 100)).toThrow(SlotError);
    expect(() => textSlot("a\rb", "body", 100)).toThrow(SlotError);
  });

  it("rejects a leading -", () => {
    expect(() => textSlot("-oops", "body", 100)).toThrow(SlotError);
  });

  it("bounds length", () => {
    expect(() => textSlot("a".repeat(101), "body", 100)).toThrow(SlotError);
  });

  it("rejects a non-string", () => {
    expect(() => textSlot(42, "body", 100)).toThrow(SlotError);
  });
});
