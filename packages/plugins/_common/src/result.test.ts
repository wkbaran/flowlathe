import { describe, expect, it } from "vitest";
import { toolFail, toolOk } from "./result.js";

describe("toolOk/toolFail", () => {
  it("wraps success data with ok:true first (key order is part of the contract)", () => {
    expect(toolOk({ x: 1 })).toBe(JSON.stringify({ ok: true, data: { x: 1 } }));
  });

  it("wraps a failure message with ok:false", () => {
    expect(toolFail("boom")).toBe(JSON.stringify({ ok: false, error: "boom" }));
  });

  it("round-trips through JSON.parse", () => {
    expect(JSON.parse(toolOk([1, 2, 3]))).toEqual({ ok: true, data: [1, 2, 3] });
    expect(JSON.parse(toolFail("nope"))).toEqual({ ok: false, error: "nope" });
  });
});
