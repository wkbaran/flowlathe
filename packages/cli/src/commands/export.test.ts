import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdExport } from "./export.js";

const VALID = `flow "f" {
  node a: prompt @(0, 0) {
    template = "hi"
    providerId = "mock"
    modelId = "m"
  }
}
`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flowlathe-cli-export-"));
  vi.stubEnv("FLOWLATHE_DB_PATH", "");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("cmdExport", () => {
  it("writes a compiled script to stdout by default", async () => {
    const file = join(dir, "a.flow");
    await writeFile(file, VALID);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const code = await cmdExport([file]);
    expect(code).toBe(0);
    const script = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(script).toContain("async function main()");
    expect(script).toContain('n_a: {"id":"a"');
    writeSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("writes to --out when given", async () => {
    const file = join(dir, "a.flow");
    const out = join(dir, "out.ts");
    await writeFile(file, VALID);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const code = await cmdExport([file, "--out", out]);
    expect(code).toBe(0);
    expect(await readFile(out, "utf8")).toContain("async function main()");
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("refuses to export a graph that fails validation", async () => {
    const file = join(dir, "bad.flow");
    await writeFile(
      file,
      `flow "f" {\n  node a: prompt @(0, 0) {\n    template = "{{input}}"\n    providerId = "mock"\n    modelId = "m"\n  }\n}\n`,
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await cmdExport([file]);
    expect(code).toBe(1);
    errSpy.mockRestore();
  });

  it("errors with usage when no file is given", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await cmdExport([]);
    expect(code).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("usage:"));
    errSpy.mockRestore();
  });
});
