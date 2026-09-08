import { describe, expect, it } from "vitest";
import { extractTemplateVars, renderTemplate } from "./template.js";

describe("template", () => {
  it("extracts distinct placeholder names in order of first appearance", () => {
    expect(extractTemplateVars("Hi {{name}}, your {{name}} is {{status}}.")).toEqual([
      "name",
      "status",
    ]);
  });

  it("returns an empty list for a template with no placeholders", () => {
    expect(extractTemplateVars("no placeholders here")).toEqual([]);
  });

  it("renders a template by substituting each variable", () => {
    expect(renderTemplate("Summarize: {{input}}", { input: "hello" })).toBe("Summarize: hello");
  });

  it("throws when a required variable is missing", () => {
    expect(() => renderTemplate("{{missing}}", {})).toThrow(/missing template variable/);
  });

  it("throws for a prototype-chain property name instead of resolving it off Object.prototype", () => {
    expect(() => renderTemplate("{{toString}}", {})).toThrow(/missing template variable/);
    expect(() => renderTemplate("{{constructor}}", {})).toThrow(/missing template variable/);
  });

  it("still renders normally when toString is a real own property", () => {
    expect(renderTemplate("{{toString}}", { toString: "hello" })).toBe("hello");
  });
});
