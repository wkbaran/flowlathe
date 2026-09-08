import { describe, expect, it, vi } from "vitest";
import { retryAfterMsFromHeader } from "./retry-after.js";

describe("retryAfterMsFromHeader", () => {
  it("parses a plain seconds value", () => {
    expect(retryAfterMsFromHeader("5")).toBe(5000);
  });

  it("parses an HTTP-date value", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(retryAfterMsFromHeader(new Date("2026-01-01T00:00:10Z").toUTCString())).toBe(10_000);
    vi.useRealTimers();
  });

  it("clamps a value over the ceiling to 60s", () => {
    expect(retryAfterMsFromHeader("999999")).toBe(60_000);
  });

  it("clamps a far-future HTTP-date to 60s", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    expect(retryAfterMsFromHeader(new Date("2030-01-01T00:00:00Z").toUTCString())).toBe(60_000);
    vi.useRealTimers();
  });

  it("floors a negative value at 0", () => {
    expect(retryAfterMsFromHeader("-5")).toBe(0);
  });

  it("returns undefined for garbage input", () => {
    expect(retryAfterMsFromHeader("not a number or date")).toBeUndefined();
  });

  it("returns undefined for null/empty", () => {
    expect(retryAfterMsFromHeader(null)).toBeUndefined();
    expect(retryAfterMsFromHeader("")).toBeUndefined();
  });
});
