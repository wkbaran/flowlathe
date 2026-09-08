import { randomBytes } from "node:crypto";
import { ensureDefaultMockProvider, type OpenedDb, openDb, runMigrations } from "@flowlathe/persistence";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { SchedulerRegistry } from "../scheduler-registry.js";

let opened: OpenedDb;
let credentialKey: Buffer;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  ensureDefaultMockProvider(opened.db);
  credentialKey = randomBytes(32);
});

afterEach(() => {
  opened.close();
});

function buildTestApp() {
  const schedulerRegistry = new SchedulerRegistry(opened.db, credentialKey);
  return buildApp({ db: opened.db, credentialKey, schedulerRegistry });
}

describe("POST /api/providers", () => {
  it("rejects a non-URL baseUrl", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: { name: "p1", kind: "openai-compat", baseUrl: "not a url" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a non-http(s) scheme baseUrl", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: { name: "p1", kind: "openai-compat", baseUrl: "file:///etc/passwd" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("accepts a valid http(s) baseUrl", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: { name: "p1", kind: "openai-compat", baseUrl: "https://api.example.com/v1" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().baseUrl).toBe("https://api.example.com/v1");
    await app.close();
  });

  it("accepts a provider with no baseUrl at all (optional)", async () => {
    const app = buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: { name: "p1", kind: "mock" },
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});

describe("PUT /api/providers/:id", () => {
  it("rejects a non-URL baseUrl on update", async () => {
    const app = buildTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/providers",
      payload: { name: "p1", kind: "openai-compat", baseUrl: "https://api.example.com" },
    });
    const id = created.json().id as string;

    const res = await app.inject({
      method: "PUT",
      url: `/api/providers/${id}`,
      payload: { baseUrl: "not a url" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
