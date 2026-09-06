import { emptyFlowGraph } from "@flowlathe/core";
import { beforeEach, describe, expect, it } from "vitest";
import { recordContextCompaction } from "./contexts.js";
import { type OpenedDb, openDb } from "./db.js";
import { startExecution } from "./executions.js";
import { createFlow } from "./flows.js";
import { runMigrations } from "./migrate.js";

let opened: OpenedDb;
let executionId: string;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  const flow = createFlow(opened.db, "My Flow", emptyFlowGraph());
  executionId = startExecution(opened.db, flow.flowVersionId).executionId;
});

describe("context compaction lineage", () => {
  it("materializes source and result contexts as content-addressed message lists", () => {
    const recorded = recordContextCompaction(opened.db, {
      executionId,
      nodeId: "a",
      method: "drop-oldest-half",
      sourceMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      resultMessages: [
        { role: "system", content: "sys" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(recorded.sourceContextId).not.toBe(recorded.resultContextId);
    expect(recorded.transformCallId).toBeTruthy();
  });

  it("records which node's compaction this was without requiring a models table row", () => {
    expect(() =>
      recordContextCompaction(opened.db, {
        executionId,
        nodeId: "a",
        method: "summarize-oldest-half",
        sourceMessages: [{ role: "user", content: "long transcript" }],
        resultMessages: [{ role: "system", content: "summary" }],
      }),
    ).not.toThrow();
  });
});
