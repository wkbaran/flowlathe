import { mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlowGraph } from "@flowlathe/core";
import { createFlow, getExecution, type OpenedDb, openDb, runMigrations } from "@flowlathe/persistence";
import { MockProviderAdapter, SimpleScheduler } from "@flowlathe/providers";
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionHub } from "./execution-hub.js";
import { runFlow } from "./executor.js";

let opened: OpenedDb;
let root: string;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  root = realpathSync(mkdtempSync(join(tmpdir(), "flowlathe-state-files-e2e-")));
});

async function waitForExecutionToFinish(db: OpenedDb["db"], executionId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const execution = getExecution(db, executionId);
    if (execution && (execution.status === "finished" || execution.status === "failed")) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`execution "${executionId}" did not settle in time`);
}

function graphFor(): FlowGraph {
  return {
    nodes: [
      {
        id: "a",
        type: "prompt",
        position: { x: 0, y: 0 },
        data: { template: "resource: {{resource}}; notes: {{notes}}", providerId: "mock", modelId: "m" },
      },
    ],
    edges: [],
    state: [
      { name: "resource", type: "file", merge: "replace", fileMode: "read-only", filePath: "resource.md" },
      {
        name: "notes",
        type: "file",
        merge: "replace",
        fileMode: "read-write",
        filePath: "notes.md",
        versioned: true,
      },
    ],
  };
}

describe("runFlow — file-backed state entries end to end (PLAN-STATE-FILES.md)", () => {
  it("reads a read-only resource and a versioned notes seed into the rendered prompt, minting a distinct file per run", async () => {
    writeFileSync(join(root, "resource.md"), "REFERENCE_DOC");
    writeFileSync(join(root, "notes.md"), "SEED_NOTES");

    const flow = createFlow(opened.db, "File State E2E", graphFor());
    const hub = new ExecutionHub();
    const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 4 } });

    const { executionId: run1 } = runFlow({
      db: opened.db,
      hub,
      scheduler,
      flowVersionId: flow.flowVersionId,
      graph: flow.graph,
      stateFilesRoot: root,
      flowVersion: flow.version,
    });
    await waitForExecutionToFinish(opened.db, run1);
    expect(getExecution(opened.db, run1)?.status).toBe("finished");

    const responseRows1 = opened.sqlite
      .prepare("SELECT rendered_prompt_sha FROM responses WHERE execution_id = ?")
      .all(run1) as { rendered_prompt_sha: string }[];
    expect(responseRows1).toHaveLength(1);
    const promptBytes1 = opened.sqlite
      .prepare("SELECT bytes FROM blobs WHERE sha256 = ?")
      .get(responseRows1[0]!.rendered_prompt_sha) as { bytes: Buffer };
    const renderedPrompt1 = promptBytes1.bytes.toString("utf-8");
    expect(renderedPrompt1).toBe("resource: REFERENCE_DOC; notes: SEED_NOTES");

    const mintedAfterRun1 = readdirSync(root).filter((f) => f !== "resource.md" && f !== "notes.md");
    expect(mintedAfterRun1).toHaveLength(1);
    expect(readFileSync(join(root, mintedAfterRun1[0]!), "utf-8")).toBe("SEED_NOTES");
    // the read-only resource and the versioned template are both untouched
    expect(readFileSync(join(root, "resource.md"), "utf-8")).toBe("REFERENCE_DOC");
    expect(readFileSync(join(root, "notes.md"), "utf-8")).toBe("SEED_NOTES");

    // A second run mints a SECOND, distinctly-named file.
    const { executionId: run2 } = runFlow({
      db: opened.db,
      hub,
      scheduler,
      flowVersionId: flow.flowVersionId,
      graph: flow.graph,
      stateFilesRoot: root,
      flowVersion: flow.version,
    });
    await waitForExecutionToFinish(opened.db, run2);
    expect(getExecution(opened.db, run2)?.status).toBe("finished");

    const mintedAfterRun2 = readdirSync(root).filter((f) => f !== "resource.md" && f !== "notes.md");
    expect(mintedAfterRun2).toHaveLength(2);
  }, 10_000);

  it("fails the run clearly when a type:\"file\" entry is declared but FLOWLATHE_STATE_FILES_ROOT is not configured", async () => {
    const flow = createFlow(opened.db, "File State No Root", graphFor());
    const hub = new ExecutionHub();
    const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 4 } });

    const { executionId } = runFlow({
      db: opened.db,
      hub,
      scheduler,
      flowVersionId: flow.flowVersionId,
      graph: flow.graph,
      // stateFilesRoot deliberately omitted
    });
    await waitForExecutionToFinish(opened.db, executionId);
    expect(getExecution(opened.db, executionId)?.status).toBe("failed");
    const errorJson = getExecution(opened.db, executionId)?.errorJson as { message?: string } | null;
    expect(errorJson?.message).toMatch(/FLOWLATHE_STATE_FILES_ROOT/);
  }, 10_000);
});
