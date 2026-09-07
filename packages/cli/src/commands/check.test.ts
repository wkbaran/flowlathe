import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdCheck } from "./check.js";

const VALID = `flow "f" {
  node a: prompt @(0, 0) {
    template = "hi"
    providerId = "mock"
    modelId = "m"
  }
}
`;

// providerId is missing (PromptNodeDataSchema requires it) — a per-kind schema failure, not a
// parse failure.
const SCHEMA_INVALID = `flow "f" {
  node a: prompt @(0, 0) {
    template = "hi"
  }
}
`;

// "input" is declared as extract's only template var but has no incoming edge — validateGraph's
// R7 (every declared input port needs a wired edge).
const GRAPH_INVALID = `flow "f" {
  node a: prompt @(0, 0) {
    template = "{{input}}"
    providerId = "mock"
    modelId = "m"
  }
}
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flowlathe-cli-check-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cmdCheck", () => {
  it("exits 0 and prints ok for a valid file", async () => {
    const file = join(dir, "a.flow");
    await writeFile(file, VALID);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await cmdCheck([file]);
    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("ok"));
    logSpy.mockRestore();
  });

  it("catches a per-kind schema error and names the node", async () => {
    const file = join(dir, "a.flow");
    await writeFile(file, SCHEMA_INVALID);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await cmdCheck([file]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('node "a"'));
    errSpy.mockRestore();
  });

  it("catches a validateGraph error (unwired required port)", async () => {
    const file = join(dir, "a.flow");
    await writeFile(file, GRAPH_INVALID);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await cmdCheck([file]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("no incoming edge"));
    errSpy.mockRestore();
  });

  it("catches a DslError parse failure with line/column in the message", async () => {
    const file = join(dir, "bad.flow");
    await writeFile(file, "flow ??? {");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await cmdCheck([file]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/line \d+, column \d+/));
    errSpy.mockRestore();
  });
});
