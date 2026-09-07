import { describe, expect, it } from "vitest";
import { tokenize } from "./lex.js";
import { DslError } from "./errors.js";

describe("tokenize", () => {
  it("lexes identifiers, punctuation, and the arrow", () => {
    const toks = tokenize("flow node body -> a.b");
    expect(toks.map((t) => [t.type, t.value])).toEqual([
      ["ident", "flow"],
      ["ident", "node"],
      ["ident", "body"],
      ["punct", "->"],
      ["ident", "a"],
      ["punct", "."],
      ["ident", "b"],
      ["eof", ""],
    ]);
  });

  it("lexes identifiers containing internal hyphens (merge rule names)", () => {
    const toks = tokenize("error-on-conflict numeric-add set-union");
    expect(toks.filter((t) => t.type === "ident").map((t) => t.value)).toEqual([
      "error-on-conflict",
      "numeric-add",
      "set-union",
    ]);
  });

  it("does not swallow -> as part of a preceding identifier", () => {
    const toks = tokenize("a.port -> b.port");
    expect(toks.map((t) => t.value)).toEqual(["a", ".", "port", "->", "b", ".", "port", ""]);
  });

  it("lexes numbers, including negative and decimal", () => {
    const toks = tokenize("42 -3.5 0 -0.25");
    expect(toks.filter((t) => t.type === "number").map((t) => Number(t.value))).toEqual([42, -3.5, 0, -0.25]);
  });

  it("lexes double-quoted strings with escapes", () => {
    const toks = tokenize(String.raw`"hello \"world\"\nline2\ttab"`);
    expect(toks[0]!.value).toBe('hello "world"\nline2\ttab');
  });

  it("errors on a newline inside a plain string", () => {
    expect(() => tokenize('"abc\ndef"')).toThrow(DslError);
  });

  it("errors on an unterminated string", () => {
    expect(() => tokenize('"abc')).toThrow(/unterminated string/);
  });

  it("errors on an unterminated triple-quoted string", () => {
    expect(() => tokenize('"""abc')).toThrow(/unterminated triple-quoted string/);
  });

  it("dedents a triple-quoted string", () => {
    const source = ['template = """', "      line one", "", "      line two", '    """'].join("\n");
    const toks = tokenize(source);
    const stringTok = toks.find((t) => t.type === "string")!;
    expect(stringTok.isTriple).toBe(true);
    expect(stringTok.value).toBe("line one\n\nline two");
  });

  it("attaches a comment immediately above a token as leadingComment", () => {
    const toks = tokenize(["# a comment", "node extract: prompt {"].join("\n"));
    const nodeTok = toks.find((t) => t.type === "ident" && t.value === "node")!;
    expect(nodeTok.leadingComment).toBe("a comment");
  });

  it("does not attach a comment separated from its token by a blank line", () => {
    const toks = tokenize(["# a comment", "", "node extract: prompt {"].join("\n"));
    const nodeTok = toks.find((t) => t.type === "ident" && t.value === "node")!;
    expect(nodeTok.leadingComment).toBeUndefined();
  });

  it("joins multiple contiguous comment lines", () => {
    const toks = tokenize(["# line one", "# line two", "node extract: prompt {"].join("\n"));
    const nodeTok = toks.find((t) => t.type === "ident" && t.value === "node")!;
    expect(nodeTok.leadingComment).toBe("line one\nline two");
  });

  it("reports line/column on an unexpected character", () => {
    try {
      tokenize("flow\n  node ~bad {");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DslError);
      const err = e as DslError;
      expect(err.line).toBe(2);
      expect(err.column).toBe(8);
    }
  });
});
