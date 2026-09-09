import { describe, expect, it } from "vitest";
import { DslError } from "./errors.js";
import { parse } from "./parse.js";

const EXAMPLE = `
flow "research-brief" {
  state findings: array merge=append initial=[]
  state verdict: string merge=replace

  node extract: prompt @(80, 40) {
    providerId = "ollama"
    modelId = "qwen3.6:27b"
    enabledToolsets = ["searxng"]
    enableStateTools = true
    template = """
      Extract the key claims from the following text.

      {{input}}
    """
  }

  node critique: loop @(340, 40) {
    initTemplate = "{{input}}"
    accPortName = "input"
    stopValue = "DONE"
    maxIterations = 10

    body {
      node judge: prompt @(40, 40) {
        providerId = "ollama"
        modelId = "ornith:9b"
        template = "Critique this draft:\\n{{input}}"
      }
      node revise: prompt @(300, 40) {
        providerId = "ollama"
        modelId = "ornith:9b"
        template = "Revise using the critique:\\n{{input}}"
      }
      judge.output -> revise.input
    }
  }

  extract.output -> critique.input
}
`;

describe("parse", () => {
  it("parses the flow name", () => {
    expect(parse(EXAMPLE).name).toBe("research-brief");
  });

  it("parses state declarations", () => {
    const { graph } = parse(EXAMPLE);
    expect(graph.state).toEqual([
      { name: "findings", type: "array", merge: "append", initial: [] },
      { name: "verdict", type: "string", merge: "replace" },
    ]);
  });

  it("defaults state type to string when omitted", () => {
    const { graph } = parse('flow "f" {\n  state x merge=replace\n}\n');
    expect(graph.state).toEqual([{ name: "x", type: "string", merge: "replace" }]);
  });

  it("parses a file-backed state decl's filePath/fileMode/versioned (PLAN-STATE-FILES.md)", () => {
    const source =
      'flow "f" {\n  state notes: file merge=replace filePath="notes/seed.md" fileMode=read-write versioned=true\n}\n';
    const { graph } = parse(source);
    expect(graph.state).toEqual([
      {
        name: "notes",
        type: "file",
        merge: "replace",
        filePath: "notes/seed.md",
        fileMode: "read-write",
        versioned: true,
      },
    ]);
  });

  it("parses a read-only file-backed state decl with versioned omitted", () => {
    const source = 'flow "f" {\n  state resource: file merge=replace filePath="doc.md" fileMode=read-only\n}\n';
    const { graph } = parse(source);
    expect(graph.state).toEqual([
      { name: "resource", type: "file", merge: "replace", filePath: "doc.md", fileMode: "read-only" },
    ]);
  });

  it("rejects an unknown fileMode", () => {
    const source = 'flow "f" {\n  state notes: file merge=replace filePath="a.md" fileMode=bogus\n}\n';
    expect(() => parse(source)).toThrow(/unknown fileMode/);
  });

  it("parses top-level and nested node declarations, with parentId sugar", () => {
    const { graph } = parse(EXAMPLE);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get("extract")).toMatchObject({
      type: "prompt",
      position: { x: 80, y: 40 },
      data: {
        providerId: "ollama",
        modelId: "qwen3.6:27b",
        enabledToolsets: ["searxng"],
        enableStateTools: true,
        template: "Extract the key claims from the following text.\n\n{{input}}",
      },
    });
    expect(byId.get("judge")).toMatchObject({ parentId: "critique" });
    expect(byId.get("revise")).toMatchObject({ parentId: "critique" });
    expect(byId.get("critique")!.parentId).toBeUndefined();
  });

  it("parses edges, including inside a body block", () => {
    const { graph } = parse(EXAMPLE);
    const outer = graph.edges.find((e) => e.source === "extract")!;
    expect(outer).toMatchObject({ source: "extract", target: "critique", sourceHandle: "output", targetHandle: "input" });
    const inner = graph.edges.find((e) => e.source === "judge")!;
    expect(inner).toMatchObject({ source: "judge", target: "revise", sourceHandle: "output", targetHandle: "input" });
  });

  it("defaults node position to (0, 0) when omitted", () => {
    const { graph } = parse('flow "f" {\n  node a: prompt {\n    x = 1\n  }\n}\n');
    expect(graph.nodes[0]!.position).toEqual({ x: 0, y: 0 });
  });

  it("parses arrays, objects, numbers, booleans, and null", () => {
    const source = `flow "f" {
  node a: router @(0, 0) {
    routes = ["x", "y"]
    cases = [{value: "a", route: "x"}, {value: "b", route: "y"}]
    n = -3.5
    flag = true
    other = false
    nothing = null
  }
}
`;
    const { graph } = parse(source);
    expect(graph.nodes[0]!.data).toEqual({
      routes: ["x", "y"],
      cases: [
        { value: "a", route: "x" },
        { value: "b", route: "y" },
      ],
      n: -3.5,
      flag: true,
      other: false,
      nothing: null,
    });
  });

  it("allows trailing commas in arrays and objects", () => {
    const source = `flow "f" {
  node a: router @(0, 0) {
    routes = ["x", "y",]
    obj = {a: 1, b: 2,}
  }
}
`;
    const { graph } = parse(source);
    expect(graph.nodes[0]!.data).toEqual({ routes: ["x", "y"], obj: { a: 1, b: 2 } });
  });

  it("preserves a leading comment attached to a node", () => {
    const source = `flow "f" {
  # extracts claims
  node a: prompt @(0, 0) {
    template = "x"
  }
}
`;
    const { comments } = parse(source);
    expect(comments["node:a"]).toBe("extracts claims");
  });
});

describe("parse errors", () => {
  it("rejects an unknown node kind", () => {
    const source = 'flow "f" {\n  node a: bogus @(0, 0) {\n  }\n}\n';
    try {
      parse(source);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      expect((e as DslError).message).toMatch(/unknown node kind "bogus"/);
      expect((e as DslError).line).toBe(2);
    }
  });

  it("rejects a duplicate node name", () => {
    const source = 'flow "f" {\n  node a: prompt @(0, 0) {\n    template = "x"\n  }\n  node a: prompt @(1, 0) {\n    template = "y"\n  }\n}\n';
    try {
      parse(source);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      expect((e as DslError).message).toMatch(/duplicate node name "a"/);
    }
  });

  it("rejects an edge referencing a missing node", () => {
    const source = 'flow "f" {\n  node a: prompt @(0, 0) {\n    template = "x"\n  }\n  a.output -> missing.input\n}\n';
    try {
      parse(source);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      expect((e as DslError).message).toMatch(/node "missing", which is not declared/);
    }
  });

  it("rejects a state decl missing merge", () => {
    const source = 'flow "f" {\n  state x: string\n}\n';
    expect(() => parse(source)).toThrow(/missing its required "merge"/);
  });

  it("carries line/column on a generic syntax error", () => {
    try {
      parse('flow "f" {\n  node a prompt {\n  }\n}\n');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      expect((e as DslError).line).toBe(2);
    }
  });
});
