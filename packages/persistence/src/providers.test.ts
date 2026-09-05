import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { type OpenedDb, openDb } from "./db.js";
import { runMigrations } from "./migrate.js";
import {
  createProvider,
  deleteProvider,
  getProvider,
  getProviderSecret,
  listProviders,
  updateProvider,
} from "./providers.js";

let opened: OpenedDb;
let key: Buffer;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  key = randomBytes(32);
});

describe("provider repository", () => {
  it("creates a provider and never exposes the raw secret", () => {
    const created = createProvider(opened.db, key, {
      name: "Local LM Studio",
      kind: "openai-compat",
      baseUrl: "http://127.0.0.1:1234/v1",
      secret: "sk-abc123",
      maxParallel: 2,
    });
    expect(created.hasSecret).toBe(true);
    expect(JSON.stringify(created)).not.toContain("sk-abc123");
    expect(getProviderSecret(opened.db, key, created.id)).toBe("sk-abc123");
  });

  it("lists and fetches providers without secrets", () => {
    createProvider(opened.db, key, { name: "A", kind: "mock" });
    createProvider(opened.db, key, { name: "B", kind: "ollama", baseUrl: "http://127.0.0.1:11434" });
    expect(listProviders(opened.db).map((p) => p.name).sort()).toEqual(["A", "B"]);
  });

  it("updates fields, including rotating the secret", () => {
    const created = createProvider(opened.db, key, { name: "A", kind: "openai-compat", secret: "old" });
    const updated = updateProvider(opened.db, key, created.id, { secret: "new", maxParallel: 5 });
    expect(updated.maxParallel).toBe(5);
    expect(getProviderSecret(opened.db, key, created.id)).toBe("new");
  });

  it("deletes a provider", () => {
    const created = createProvider(opened.db, key, { name: "A", kind: "mock" });
    deleteProvider(opened.db, created.id);
    expect(getProvider(opened.db, created.id)).toBeUndefined();
  });
});
