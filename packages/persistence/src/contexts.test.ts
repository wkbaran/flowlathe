import { emptyFlowGraph } from "@flowlathe/core";
import { beforeEach, describe, expect, it } from "vitest";
import { recordContextTransform } from "./contexts.js";
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

describe("context transform lineage", () => {
  it("materializes source and result contexts as content-addressed message lists", () => {
    const recorded = recordContextTransform(opened.db, {
      executionId,
      transformKind: "drop-before",
      sourceMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      resultMessages: [{ role: "assistant", content: "hello" }],
    });
    expect(recorded.sourceContextId).not.toBe(recorded.resultContextId);
    expect(recorded.transformCallId).toBeTruthy();
  });

  it("keeps provider/model info in paramsJson without requiring a models table row", () => {
    // no FK violation even though "mock"/"m" aren't real `models.id` rows
    expect(() =>
      recordContextTransform(opened.db, {
        executionId,
        transformKind: "summarize",
        sourceMessages: [{ role: "user", content: "long transcript" }],
        resultMessages: [{ role: "system", content: "summary" }],
        providerId: "mock",
        modelId: "m",
      }),
    ).not.toThrow();
  });
});
