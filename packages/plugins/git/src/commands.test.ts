import { describe, expect, it } from "vitest";
import {
  addArgv,
  commitArgv,
  createBranchArgv,
  diffArgv,
  listBranchesArgv,
  logArgv,
  pushArgv,
  revParseHeadArgv,
  showArgv,
  statusArgv,
  switchArgv,
} from "./commands.js";

const root = "/repo";

describe("statusArgv", () => {
  it("has no model-facing arguments and always the same shape", () => {
    expect(statusArgv(root)).toEqual(["-C", root, "status", "--porcelain=v2", "--branch", "--untracked-files=normal"]);
  });
});

describe("logArgv", () => {
  it("with only limit: no ref element, no pathspec", () => {
    expect(logArgv(root, { limit: 20 })).toEqual(["-C", root, "log", "-z", "--max-count=20", "--format=%H%x1f%aI%x1f%an%x1f%s"]);
  });

  it("with ref: appends it as a bare element, not passed empty when present", () => {
    expect(logArgv(root, { limit: 5, ref: "main" })).toEqual([
      "-C",
      root,
      "log",
      "-z",
      "--max-count=5",
      "--format=%H%x1f%aI%x1f%an%x1f%s",
      "main",
    ]);
  });

  it("with path: preceded by a literal --", () => {
    expect(logArgv(root, { limit: 5, path: "src/x.ts" })).toEqual([
      "-C",
      root,
      "log",
      "-z",
      "--max-count=5",
      "--format=%H%x1f%aI%x1f%an%x1f%s",
      "--",
      "src/x.ts",
    ]);
  });

  it("with ref and path together", () => {
    expect(logArgv(root, { limit: 100, ref: "feature/x", path: "a/b.ts" })).toEqual([
      "-C",
      root,
      "log",
      "-z",
      "--max-count=100",
      "--format=%H%x1f%aI%x1f%an%x1f%s",
      "feature/x",
      "--",
      "a/b.ts",
    ]);
  });
});

describe("diffArgv", () => {
  it("with neither ref: no range element", () => {
    expect(diffArgv(root, {})).toEqual(["-C", root, "diff", "--no-color", "--no-ext-diff"]);
  });

  it("with only fromRef: a bare element, not a range", () => {
    expect(diffArgv(root, { fromRef: "main" })).toEqual(["-C", root, "diff", "--no-color", "--no-ext-diff", "main"]);
  });

  it("with both refs: exactly one from..to element, not two elements", () => {
    const argv = diffArgv(root, { fromRef: "main", toRef: "feature/x" });
    expect(argv).toEqual(["-C", root, "diff", "--no-color", "--no-ext-diff", "main..feature/x"]);
    expect(argv.filter((a) => a.includes(".."))).toHaveLength(1);
  });

  it("staged adds --cached before the range", () => {
    expect(diffArgv(root, { staged: true })).toEqual(["-C", root, "diff", "--no-color", "--no-ext-diff", "--cached"]);
  });

  it("staged omitted (false) never adds --cached", () => {
    expect(diffArgv(root, { staged: false })).toEqual(["-C", root, "diff", "--no-color", "--no-ext-diff"]);
  });

  it("path is preceded by a literal --", () => {
    expect(diffArgv(root, { fromRef: "main", path: "src/x.ts" })).toEqual([
      "-C",
      root,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "main",
      "--",
      "src/x.ts",
    ]);
  });

  it("every optional combination together", () => {
    expect(diffArgv(root, { fromRef: "a", toRef: "b", path: "p.ts", staged: true })).toEqual([
      "-C",
      root,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--cached",
      "a..b",
      "--",
      "p.ts",
    ]);
  });
});

describe("showArgv", () => {
  it("without path: the commit-and-patch shape", () => {
    expect(showArgv(root, { ref: "abc123" })).toEqual(["-C", root, "show", "--no-color", "--no-ext-diff", "--format=%H%x1f%aI%x1f%an%x1f%B", "abc123"]);
  });

  it("with path: the ref:path shape, no --no-ext-diff, no --format", () => {
    const argv = showArgv(root, { ref: "abc123", path: "src/x.ts" });
    expect(argv).toEqual(["-C", root, "show", "--no-color", "abc123:src/x.ts"]);
    expect(argv).not.toContain("--no-ext-diff");
    expect(argv.some((a) => a.startsWith("--format="))).toBe(false);
  });
});

describe("listBranchesArgv", () => {
  it("has no model-facing arguments and always the same shape", () => {
    expect(listBranchesArgv(root)).toEqual([
      "-C",
      root,
      "branch",
      "--list",
      "--format=%(HEAD)%1f%(refname:short)%1f%(objectname:short)%1f%(upstream:short)",
    ]);
  });

  it("uses the bare %1f ref-format hex escape, never the log-style %x1f", () => {
    // git branch --format uses the for-each-ref engine, which does not understand %x1f at all —
    // it would be emitted completely literally, silently corrupting every field split.
    const argv = listBranchesArgv(root);
    expect(argv.some((a) => a.includes("%x1f"))).toBe(false);
  });
});

describe("addArgv", () => {
  it("a single path, preceded by --", () => {
    expect(addArgv(root, ["a.ts"])).toEqual(["-C", root, "add", "--", "a.ts"]);
  });

  it("multiple paths, all after one --", () => {
    expect(addArgv(root, ["a.ts", "b.ts", "c.ts"])).toEqual(["-C", root, "add", "--", "a.ts", "b.ts", "c.ts"]);
  });
});

describe("commitArgv", () => {
  it("carries the message via -m, with --cleanup=whitespace and no -a/--amend/--no-verify", () => {
    const argv = commitArgv(root, "fix: something");
    expect(argv).toEqual(["-C", root, "commit", "--cleanup=whitespace", "-m", "fix: something"]);
    expect(argv).not.toContain("-a");
    expect(argv).not.toContain("--amend");
    expect(argv).not.toContain("--no-verify");
  });
});

describe("revParseHeadArgv", () => {
  it("has no model-facing arguments", () => {
    expect(revParseHeadArgv(root)).toEqual(["-C", root, "rev-parse", "HEAD"]);
  });
});

describe("createBranchArgv", () => {
  it("without fromRef: defaults to the current HEAD implicitly (no third element)", () => {
    expect(createBranchArgv(root, { name: "feature/x" })).toEqual(["-C", root, "switch", "--create", "feature/x"]);
  });

  it("with fromRef: appended as a bare element", () => {
    expect(createBranchArgv(root, { name: "feature/x", fromRef: "main" })).toEqual(["-C", root, "switch", "--create", "feature/x", "main"]);
  });
});

describe("switchArgv", () => {
  it("no --force/--detach/--discard-changes/-c", () => {
    const argv = switchArgv(root, "main");
    expect(argv).toEqual(["-C", root, "switch", "main"]);
    expect(argv).not.toContain("--force");
    expect(argv).not.toContain("--detach");
    expect(argv).not.toContain("-c");
  });
});

describe("pushArgv", () => {
  it("produces exactly [-C, root, push, remote, HEAD] for every input — there is no input", () => {
    expect(pushArgv(root, "origin")).toEqual(["-C", root, "push", "origin", "HEAD"]);
    expect(pushArgv(root, "upstream")).toEqual(["-C", root, "push", "upstream", "HEAD"]);
  });
});

describe("every template", () => {
  it("starts with -C <root>", () => {
    const builders: string[][] = [
      statusArgv(root),
      logArgv(root, { limit: 1 }),
      diffArgv(root, {}),
      showArgv(root, { ref: "x" }),
      listBranchesArgv(root),
      addArgv(root, ["a"]),
      commitArgv(root, "m"),
      revParseHeadArgv(root),
      createBranchArgv(root, { name: "x" }),
      switchArgv(root, "x"),
      pushArgv(root, "origin"),
    ];
    for (const argv of builders) {
      expect(argv.slice(0, 2)).toEqual(["-C", root]);
    }
  });
});
