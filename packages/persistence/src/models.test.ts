import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { type OpenedDb, openDb } from "./db.js";
import { runMigrations } from "./migrate.js";
import { createModel, deleteModel, listModels } from "./models.js";
import { createProvider } from "./providers.js";

let opened: OpenedDb;
let providerId: string;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  providerId = createProvider(opened.db, randomBytes(32), { name: "P", kind: "mock" }).id;
});

describe("model repository", () => {
  it("creates and lists models for a provider", () => {
    createModel(opened.db, { providerId, modelName: "llama3", contextWindow: 8192 });
    createModel(opened.db, { providerId, modelName: "qwen" });
    expect(listModels(opened.db, providerId).map((m) => m.modelName).sort()).toEqual(["llama3", "qwen"]);
  });

  it("deletes a model", () => {
    const model = createModel(opened.db, { providerId, modelName: "llama3" });
    deleteModel(opened.db, model.id);
    expect(listModels(opened.db, providerId)).toEqual([]);
  });
});
