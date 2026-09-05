import { type OpenedDb, openDb, runMigrations } from "@flowlathe/persistence";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

let opened: OpenedDb;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  app = buildApp({ db: opened.db });
});

afterEach(async () => {
  await app.close();
  opened.close();
});

describe("flow API", () => {
  it("creates a flow and lists it", async () => {
    const created = await app.inject({ method: "POST", url: "/api/flows", payload: { name: "My Flow" } });
    expect(created.statusCode).toBe(201);
    const flow = created.json();
    expect(flow.name).toBe("My Flow");

    const listed = await app.inject({ method: "GET", url: "/api/flows" });
    expect(listed.json()).toEqual([
      { id: flow.id, name: flow.name, createdAt: flow.createdAt, updatedAt: flow.updatedAt },
    ]);
  });

  it("persists a saved graph across reads", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/api/flows", payload: { name: "My Flow" } })
    ).json();

    const graph = { nodes: [{ id: "a", type: "prompt", position: { x: 1, y: 2 }, data: {} }], edges: [] };
    const saved = await app.inject({ method: "PUT", url: `/api/flows/${created.id}`, payload: { graph } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().version).toBe(2);

    const fetched = await app.inject({ method: "GET", url: `/api/flows/${created.id}` });
    expect(fetched.json().graph).toEqual(graph);
  });

  it("404s for an unknown flow id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/flows/does-not-exist" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a malformed graph on save", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/api/flows", payload: { name: "My Flow" } })
    ).json();
    const res = await app.inject({
      method: "PUT",
      url: `/api/flows/${created.id}`,
      payload: { graph: { nodes: [{ id: "a" }], edges: [] } },
    });
    expect(res.statusCode).toBe(400);
  });
});
