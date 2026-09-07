import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdFlows } from "./flows.js";

const CHAIN = `flow "research-brief" {
  node a: prompt @(0, 0) {
    template = "start"
    providerId = "mock"
    modelId = "m"
  }

  node b: prompt @(1, 0) {
    template = "next: {{input}}"
    providerId = "mock"
    modelId = "m"
  }

  a.output -> b.input
}
`;

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flowlathe-cli-flows-"));
  dbPath = join(dir, "flowlathe.sqlite");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cmdFlows", () => {
  it("import creates a new flow, export writes it back out as the same .flow text", async () => {
    const file = join(dir, "research-brief.flow");
    await writeFile(file, CHAIN);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const importCode = await cmdFlows(["import", file, "--db", dbPath]);
    expect(importCode).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('created "research-brief"'));

    const outDir = join(dir, "out");
    const exportCode = await cmdFlows(["export", "--dir", outDir, "--db", dbPath]);
    expect(exportCode).toBe(0);

    const files = await readdir(outDir);
    expect(files).toEqual(["research-brief.flow"]);
    expect(await readFile(join(outDir, "research-brief.flow"), "utf8")).toBe(CHAIN);

    logSpy.mockRestore();
  });

  it("importing the identical flow text again dedups: no new version, not a new flow", async () => {
    const file = join(dir, "research-brief.flow");
    await writeFile(file, CHAIN);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await cmdFlows(["import", file, "--db", dbPath]);
    logSpy.mockClear();
    const code = await cmdFlows(["import", file, "--db", dbPath]);

    expect(code).toBe(0);
    // Content-hash dedup (PLAN-FLOW-VERSIONING.md §4.2): re-importing unchanged text creates no
    // new row, so this is still version 1, not 2.
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('saved "research-brief" as version 1'));
    logSpy.mockRestore();
  });

  it("importing changed flow text bumps the version, not a new flow", async () => {
    const file = join(dir, "research-brief.flow");
    await writeFile(file, CHAIN);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await cmdFlows(["import", file, "--db", dbPath]);
    await writeFile(file, CHAIN.replace('template = "start"', 'template = "start, changed"'));
    logSpy.mockClear();
    const code = await cmdFlows(["import", file, "--db", dbPath]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('saved "research-brief" as version 2'));
    logSpy.mockRestore();
  });

  it("errors without --db and no FLOWLATHE_DB_PATH set", async () => {
    vi.stubEnv("FLOWLATHE_DB_PATH", "");
    const file = join(dir, "research-brief.flow");
    await writeFile(file, CHAIN);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await cmdFlows(["import", file]);
    expect(code).toBe(1);
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });
});
