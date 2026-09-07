import { validateGraph } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { DslError } from "./errors.js";
import { parse } from "./parse.js";

/** PLAN-FLOW-DSL.md §6's error-quality list, one test each. Node-kind/name/edge-target errors
 *  are the parser's own job (structural, not per-kind semantics — see §3.1); a body-boundary
 *  crossing is legal to *parse* (the DSL doesn't know regions are special) and is instead caught
 *  by the existing `validateGraph`, same as the canvas and every other FlowGraph producer. */
describe("error quality", () => {
  it("unknown node kind names the fix", () => {
    try {
      parse('flow "f" {\n  node a: nope @(0, 0) {\n  }\n}\n');
      expect.unreachable();
    } catch (e) {
      const err = e as DslError;
      expect(err).toBeInstanceOf(DslError);
      expect(err.line).toBe(2);
      expect(err.message).toMatch(/unknown node kind "nope"/);
      expect(err.message).toMatch(/prompt/); // lists valid kinds
    }
  });

  it("duplicate node name names the earlier declaration's line", () => {
    const source = [
      'flow "f" {',
      "  node a: prompt @(0, 0) {",
      '    template = "x"',
      "  }",
      "  node a: prompt @(1, 0) {",
      '    template = "y"',
      "  }",
      "}",
      "",
    ].join("\n");
    try {
      parse(source);
      expect.unreachable();
    } catch (e) {
      const err = e as DslError;
      expect(err.line).toBe(5);
      expect(err.message).toMatch(/duplicate node name "a"/);
      expect(err.message).toMatch(/line 2/);
    }
  });

  it("edge referencing a missing node names the missing node", () => {
    const source = [
      'flow "f" {',
      "  node a: prompt @(0, 0) {",
      '    template = "x"',
      "  }",
      "  a.output -> ghost.input",
      "}",
      "",
    ].join("\n");
    try {
      parse(source);
      expect.unreachable();
    } catch (e) {
      const err = e as DslError;
      expect(err.message).toMatch(/"ghost", which is not declared/);
      expect(err.line).toBe(5);
    }
  });

  it("an edge crossing a body boundary parses, and validateGraph names the fix", () => {
    const source = [
      'flow "f" {',
      "  node loop1: loop @(0, 0) {",
      '    initTemplate = "{{input}}"',
      '    accPortName = "input"',
      '    stopValue = "DONE"',
      "    maxIterations = 5",
      "",
      "    body {",
      "      node inner: prompt @(1, 0) {",
      '        template = "{{input}}"',
      "      }",
      "    }",
      "  }",
      "  node outer: prompt @(2, 0) {",
      '    template = "x"',
      "  }",
      "  outer.output -> inner.input",
      "}",
      "",
    ].join("\n");
    const { graph } = parse(source);
    const problems = validateGraph(graph);
    expect(problems.some((p) => p.includes("crosses into a Loop/Map body"))).toBe(true);
  });

  it("unclosed triple-quote reports where the string started", () => {
    const source = 'flow "f" {\n  node a: prompt @(0, 0) {\n    template = """\n unterminated\n  }\n}\n';
    try {
      parse(source);
      expect.unreachable();
    } catch (e) {
      const err = e as DslError;
      expect(err.message).toMatch(/unterminated triple-quoted string/);
      expect(err.line).toBe(3);
    }
  });
});
