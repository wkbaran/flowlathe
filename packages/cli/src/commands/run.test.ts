import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@flowlathe/core";
import { ensureDefaultMockProvider, openDb, runMigrations } from "@flowlathe/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdRun } from "./run.js";

const CHAIN = `flow "f" {
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flowlathe-cli-run-"));
  const dbPath = join(dir, "flowlathe.sqlite");
  const opened = openDb(dbPath);
  runMigrations(opened);
  ensureDefaultMockProvider(opened.db);
  opened.close();
  vi.stubEnv("FLOWLATHE_DB_PATH", dbPath);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("cmdRun", () => {
  it("streams RunEvent JSON and finishes with the terminal node's output", async () => {
    const file = join(dir, "f.flow");
    await writeFile(file, CHAIN);
    const events: RunEvent[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => {
      events.push(JSON.parse(line) as RunEvent);
    });
    const code = await cmdRun([file]);
    logSpy.mockRestore();

    expect(code).toBe(0);
    expect(events.some((e) => e.kind === "node_finished" && e.nodeId === "b")).toBe(true);
    const finished = events.find((e) => e.kind === "run_finished");
    expect(finished).toMatchObject({ outputs: { b: expect.stringContaining("start") } });
  });

  it("refuses without a file argument", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await cmdRun([]);
    expect(code).toBe(1);
    errSpy.mockRestore();
  });
});
