import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFlowGraph } from "@flowlathe/core";
import { createFlow, openDb, runMigrations, startExecution } from "@flowlathe/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdGc } from "./gc.js";

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flowlathe-cli-gc-"));
  dbPath = join(dir, "flowlathe.sqlite");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function seedOldExecution(daysAgo: number): string {
  const opened = openDb(dbPath);
  runMigrations(opened);
  const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
  const { executionId } = startExecution(opened.db, flow.flowVersionId, "run");
  const at = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  opened.sqlite
    .prepare("UPDATE executions SET status = 'finished', started_at = ?, ended_at = ? WHERE id = ?")
    .run(at, at, executionId);
  opened.close();
  return executionId;
}

function executionExists(executionId: string): boolean {
  const opened = openDb(dbPath);
  const row = opened.sqlite.prepare("SELECT 1 FROM executions WHERE id = ?").get(executionId);
  opened.close();
  return row !== undefined;
}

describe("cmdGc", () => {
  it("--dry-run reports counts without deleting anything", async () => {
    const executionId = seedOldExecution(999);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await cmdGc(["--db", dbPath, "--older-than-days", "0", "--dry-run"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("would collect 1 execution"));
    expect(executionExists(executionId)).toBe(true);
    logSpy.mockRestore();
  });

  it("a real run deletes the eligible execution", async () => {
    const executionId = seedOldExecution(999);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await cmdGc(["--db", dbPath, "--older-than-days", "0"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("collected 1 execution"));
    expect(executionExists(executionId)).toBe(false);
    logSpy.mockRestore();
  });

  it("honours --older-than-days: a fresh-enough execution survives a real run", async () => {
    const executionId = seedOldExecution(1);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await cmdGc(["--db", dbPath, "--older-than-days", "30"]);

    expect(code).toBe(0);
    expect(executionExists(executionId)).toBe(true);
    logSpy.mockRestore();
  });

  it("--vacuum runs after a real collection", async () => {
    seedOldExecution(999);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const code = await cmdGc(["--db", dbPath, "--older-than-days", "0", "--vacuum"]);

    expect(code).toBe(0);
    expect(logSpy).toHaveBeenCalledWith("vacuumed");
    logSpy.mockRestore();
  });

  it("rejects combining --dry-run with --vacuum", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await cmdGc(["--db", dbPath, "--dry-run", "--vacuum"]);
    expect(code).toBe(1);
    errSpy.mockRestore();
  });

  it("errors without --db and no FLOWLATHE_DB_PATH set", async () => {
    vi.stubEnv("FLOWLATHE_DB_PATH", "");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await cmdGc([]);
    expect(code).toBe(1);
    errSpy.mockRestore();
    vi.unstubAllEnvs();
  });
});
