import { type OpenedDb, openDb, runMigrations } from "@flowlathe/persistence";
import { MockProviderAdapter, SimpleScheduler } from "@flowlathe/providers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

let opened: OpenedDb;
let app: ReturnType<typeof buildApp>;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 4 } });
  app = buildApp({ db: opened.db, scheduler });
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

describe("run + export", () => {
  async function createTwoNodeFlow(): Promise<string> {
    const created = (
      await app.inject({ method: "POST", url: "/api/flows", payload: { name: "Chain" } })
    ).json();
    const graph = {
      nodes: [
        { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "start", providerId: "mock", modelId: "m" } },
        {
          id: "b",
          type: "prompt",
          position: { x: 1, y: 0 },
          data: { template: "next: {{input}}", providerId: "mock", modelId: "m" },
        },
      ],
      edges: [{ id: "a-b", source: "a", target: "b", targetHandle: "input" }],
    };
    await app.inject({ method: "PUT", url: `/api/flows/${created.id}`, payload: { graph } });
    return created.id;
  }

  it("runs a flow against the mock provider and records a per-node log", async () => {
    const flowId = await createTwoNodeFlow();
    const started = await app.inject({ method: "POST", url: `/api/flows/${flowId}/run` });
    expect(started.statusCode).toBe(202);
    const { executionId } = started.json();

    let status: string | undefined;
    for (let i = 0; i < 50 && status !== "finished"; i++) {
      const res = await app.inject({ method: "GET", url: `/api/executions/${executionId}` });
      status = res.json().execution.status;
      if (status !== "finished") await new Promise((r) => setTimeout(r, 10));
    }
    expect(status).toBe("finished");

    const log = (await app.inject({ method: "GET", url: `/api/executions/${executionId}` })).json();
    expect(log.responses).toHaveLength(2);
    expect(log.responses.map((r: { nodeId: string }) => r.nodeId).sort()).toEqual(["a", "b"]);
  });

  it("exports a runnable standalone script", async () => {
    const flowId = await createTwoNodeFlow();
    const res = await app.inject({ method: "GET", url: `/api/flows/${flowId}/export` });
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toContain("MockProviderAdapter");
  });
});
