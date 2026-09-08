import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDefaultMockProvider, type OpenedDb, openDb, runMigrations } from "@flowlathe/persistence";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { SchedulerRegistry } from "../scheduler-registry.js";

let opened: OpenedDb;
let app: ReturnType<typeof buildApp>;
let flowsDir: string;

beforeEach(async () => {
  opened = openDb(":memory:");
  runMigrations(opened);
  ensureDefaultMockProvider(opened.db);
  const credentialKey = randomBytes(32);
  const schedulerRegistry = new SchedulerRegistry(opened.db, credentialKey);
  flowsDir = await mkdtemp(join(tmpdir(), "flowlathe-executions-route-"));
  app = buildApp({ db: opened.db, credentialKey, schedulerRegistry, flowsDir });
});

afterEach(async () => {
  await app.close();
  opened.close();
  await rm(flowsDir, { recursive: true, force: true });
});

async function createTwoNodeFlow(name: string): Promise<string> {
  const created = (await app.inject({ method: "POST", url: "/api/flows", payload: { name } })).json();
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

async function startStepping(flowId: string): Promise<{ executionId: string; branchId: string }> {
  const started = (await app.inject({ method: "POST", url: `/api/flows/${flowId}/step-start` })).json();
  return { executionId: started.executionId, branchId: started.branchId };
}

describe("execution route ownership", () => {
  it("404s /snapshots when branchId belongs to a different execution", async () => {
    const flowA = await createTwoNodeFlow("A");
    const flowB = await createTwoNodeFlow("B");
    const a = await startStepping(flowA);
    const b = await startStepping(flowB);

    const res = await app.inject({
      method: "GET",
      url: `/api/executions/${b.executionId}/snapshots?branchId=${a.branchId}`,
    });
    expect(res.statusCode).toBe(404);

    const ok = await app.inject({
      method: "GET",
      url: `/api/executions/${a.executionId}/snapshots?branchId=${a.branchId}`,
    });
    expect(ok.statusCode).toBe(200);
  });

  it("404s /state when branchId belongs to a different execution", async () => {
    const flowA = await createTwoNodeFlow("A");
    const flowB = await createTwoNodeFlow("B");
    const a = await startStepping(flowA);
    const b = await startStepping(flowB);

    const res = await app.inject({ method: "GET", url: `/api/executions/${b.executionId}/state?branchId=${a.branchId}` });
    expect(res.statusCode).toBe(404);
  });

  it("404s /state-lineage when branchId belongs to a different execution", async () => {
    const flowA = await createTwoNodeFlow("A");
    const flowB = await createTwoNodeFlow("B");
    const a = await startStepping(flowA);
    const b = await startStepping(flowB);

    const res = await app.inject({
      method: "GET",
      url: `/api/executions/${b.executionId}/state-lineage?branchId=${a.branchId}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s POST /step when branchId belongs to a different execution", async () => {
    const flowA = await createTwoNodeFlow("A");
    const flowB = await createTwoNodeFlow("B");
    const a = await startStepping(flowA);
    const b = await startStepping(flowB);

    const res = await app.inject({
      method: "POST",
      url: `/api/executions/${b.executionId}/step`,
      payload: { branchId: a.branchId },
    });
    expect(res.statusCode).toBe(404);

    const ok = await app.inject({
      method: "POST",
      url: `/api/executions/${a.executionId}/step`,
      payload: { branchId: a.branchId },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("404s POST /step-back when snapshotId belongs to a different execution's branch", async () => {
    const flowA = await createTwoNodeFlow("A");
    const flowB = await createTwoNodeFlow("B");
    const a = await startStepping(flowA);
    const b = await startStepping(flowB);

    const stepA = (
      await app.inject({ method: "POST", url: `/api/executions/${a.executionId}/step`, payload: { branchId: a.branchId } })
    ).json();

    const res = await app.inject({
      method: "POST",
      url: `/api/executions/${b.executionId}/step-back`,
      payload: { snapshotId: stepA.snapshotId },
    });
    expect(res.statusCode).toBe(404);

    const ok = await app.inject({
      method: "POST",
      url: `/api/executions/${a.executionId}/step-back`,
      payload: { snapshotId: stepA.snapshotId },
    });
    expect(ok.statusCode).toBe(200);
  });
});
