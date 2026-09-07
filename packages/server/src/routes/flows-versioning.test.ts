import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OpenedDb, ensureDefaultMockProvider, gcFlowVersions, openDb, runMigrations } from "@flowlathe/persistence";
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
  flowsDir = await mkdtemp(join(tmpdir(), "flowlathe-server-versioning-"));
  app = buildApp({ db: opened.db, credentialKey, schedulerRegistry, flowsDir });
});

afterEach(async () => {
  await app.close();
  opened.close();
  await rm(flowsDir, { recursive: true, force: true });
});

async function createFlow(name: string) {
  return (await app.inject({ method: "POST", url: "/api/flows", payload: { name } })).json();
}

function graphWithNode(id: string) {
  return { nodes: [{ id, type: "prompt", position: { x: 0, y: 0 }, data: {} }], edges: [] };
}

describe("GET /api/flows/:id/versions", () => {
  it("lists versions newest first with isHead and executionCount", async () => {
    const flow = await createFlow("My Flow");
    await app.inject({ method: "PUT", url: `/api/flows/${flow.id}`, payload: { graph: graphWithNode("a") } });

    const res = await app.inject({ method: "GET", url: `/api/flows/${flow.id}/versions` });
    expect(res.statusCode).toBe(200);
    const versions = res.json();
    expect(versions).toHaveLength(2);
    expect(versions[0].isHead).toBe(true);
    expect(versions[0].version).toBe(2);
    expect(versions[1].isHead).toBe(false);
  });

  it("saving an unchanged graph does not add a version row (dedup)", async () => {
    const flow = await createFlow("My Flow");
    await app.inject({ method: "PUT", url: `/api/flows/${flow.id}`, payload: { graph: graphWithNode("a") } });
    await app.inject({ method: "PUT", url: `/api/flows/${flow.id}`, payload: { graph: graphWithNode("a") } });

    const versions = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}/versions` })).json();
    expect(versions).toHaveLength(2); // create + one real save, not three
  });

  it("404s for an unknown flow", async () => {
    const res = await app.inject({ method: "GET", url: "/api/flows/does-not-exist/versions" });
    expect(res.statusCode).toBe(404);
  });
});

describe("Save as version (PUT with label)", () => {
  it("labels the resulting revision", async () => {
    const flow = await createFlow("My Flow");
    const saved = await app.inject({
      method: "PUT",
      url: `/api/flows/${flow.id}`,
      payload: { graph: graphWithNode("a"), label: "baseline", message: "first cut" },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().version).toBe(2);

    const versions = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}/versions` })).json();
    expect(versions[0].label).toBe("baseline");
    expect(versions[0].message).toBe("first cut");
  });
});

describe("POST /api/flows/:id/versions/:versionId/label", () => {
  it("labels an arbitrary past revision without duplicating it", async () => {
    const flow = await createFlow("My Flow");
    const versions = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}/versions` })).json();
    const v1Id = versions[0].id;

    const res = await app.inject({
      method: "POST",
      url: `/api/flows/${flow.id}/versions/${v1Id}/label`,
      payload: { label: "v1", message: "the beginning" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().label).toBe("v1");

    const versionsAfter = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}/versions` })).json();
    expect(versionsAfter).toHaveLength(1);
  });

  it("404s for a version id belonging to a different flow", async () => {
    const flowA = await createFlow("Flow A");
    const flowB = await createFlow("Flow B");
    const versionsA = (await app.inject({ method: "GET", url: `/api/flows/${flowA.id}/versions` })).json();

    const res = await app.inject({
      method: "POST",
      url: `/api/flows/${flowB.id}/versions/${versionsA[0].id}/label`,
      payload: { label: "x" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/flows/:id/diff", () => {
  it("diffs two versions of the same flow", async () => {
    const flow = await createFlow("My Flow");
    await app.inject({ method: "PUT", url: `/api/flows/${flow.id}`, payload: { graph: graphWithNode("a") } });
    const versions = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}/versions` })).json();
    const [v2, v1] = versions;

    const res = await app.inject({ method: "GET", url: `/api/flows/${flow.id}/diff?from=${v1.id}&to=${v2.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.diff.nodes.added.map((n: { id: string }) => n.id)).toEqual(["a"]);
    expect(body.isSemanticChange).toBe(true);
  });

  it("rejects a version id from a different flow", async () => {
    const flowA = await createFlow("Flow A");
    const flowB = await createFlow("Flow B");
    const versionsA = (await app.inject({ method: "GET", url: `/api/flows/${flowA.id}/versions` })).json();
    const versionsB = (await app.inject({ method: "GET", url: `/api/flows/${flowB.id}/versions` })).json();

    const res = await app.inject({
      method: "GET",
      url: `/api/flows/${flowA.id}/diff?from=${versionsA[0].id}&to=${versionsB[0].id}`,
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s when from/to are missing", async () => {
    const flow = await createFlow("My Flow");
    const res = await app.inject({ method: "GET", url: `/api/flows/${flow.id}/diff` });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/flows/:id/restore", () => {
  it("creates a new head equal to the restored version's graph, without rewriting history", async () => {
    const flow = await createFlow("My Flow");
    await app.inject({ method: "PUT", url: `/api/flows/${flow.id}`, payload: { graph: graphWithNode("a") } });
    const versionsBefore = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}/versions` })).json();
    const v1Id = versionsBefore[1].id; // the empty-graph original

    const restored = await app.inject({ method: "POST", url: `/api/flows/${flow.id}/restore`, payload: { versionId: v1Id } });
    expect(restored.statusCode).toBe(200);
    expect(restored.json().version).toBe(3);

    const fetched = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}` })).json();
    expect(fetched.graph.nodes).toEqual([]);

    // v1 and v2 are both still present — restore never rewrites history.
    const versionsAfter = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}/versions` })).json();
    expect(versionsAfter).toHaveLength(3);
    expect(versionsAfter.some((v: { id: string }) => v.id === v1Id)).toBe(true);

    const v3 = versionsAfter.find((v: { version: number }) => v.version === 3);
    expect(v3.parentVersionId).toBe(v1Id);
  });

  it("404s for a version id from a different flow", async () => {
    const flowA = await createFlow("Flow A");
    const flowB = await createFlow("Flow B");
    const versionsB = (await app.inject({ method: "GET", url: `/api/flows/${flowB.id}/versions` })).json();

    const res = await app.inject({
      method: "POST",
      url: `/api/flows/${flowA.id}/restore`,
      payload: { versionId: versionsB[0].id },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("flow pins", () => {
  it("pins a channel to a version and lists it back", async () => {
    const flow = await createFlow("My Flow");
    await app.inject({ method: "PUT", url: `/api/flows/${flow.id}`, payload: { graph: graphWithNode("a") } });
    const versions = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}/versions` })).json();
    const v1Id = versions[1].id;

    const res = await app.inject({
      method: "PUT",
      url: `/api/flows/${flow.id}/pins/default`,
      payload: { flowVersionId: v1Id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ flowId: flow.id, channel: "default", flowVersionId: v1Id });

    const pins = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}/pins` })).json();
    expect(pins).toHaveLength(1);
    expect(pins[0].flowVersionId).toBe(v1Id);
  });

  it("404s pinning to a version from a different flow", async () => {
    const flowA = await createFlow("Flow A");
    const flowB = await createFlow("Flow B");
    const versionsB = (await app.inject({ method: "GET", url: `/api/flows/${flowB.id}/versions` })).json();

    const res = await app.inject({
      method: "PUT",
      url: `/api/flows/${flowA.id}/pins/default`,
      payload: { flowVersionId: versionsB[0].id },
    });
    expect(res.statusCode).toBe(404);
  });

  it("a pinned unnamed revision survives GC even when every other guard would let it go", async () => {
    const flow = await createFlow("My Flow");
    const versions1 = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}/versions` })).json();
    const v1Id = versions1[0].id;
    await app.inject({ method: "PUT", url: `/api/flows/${flow.id}/pins/default`, payload: { flowVersionId: v1Id } });
    await app.inject({ method: "PUT", url: `/api/flows/${flow.id}`, payload: { graph: graphWithNode("a") } }); // v1 is no longer HEAD

    gcFlowVersions(opened.db, flow.id, { keepNewest: 0, olderThanDays: 0 });

    const versionsAfter = (await app.inject({ method: "GET", url: `/api/flows/${flow.id}/versions` })).json();
    expect(versionsAfter.some((v: { id: string }) => v.id === v1Id)).toBe(true);
  });
});

describe("git history (Layer 2, S6)", () => {
  function git(args: string[]) {
    execFileSync("git", ["-C", flowsDir, ...args], { stdio: "ignore" });
  }

  it("reports unavailable when flowsDir isn't a git repo", async () => {
    const flow = await createFlow("My Flow");
    const res = await app.inject({ method: "GET", url: `/api/flows/${flow.id}/git-history` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: false, commits: [] });
  });

  it("lists commits and diffs a past commit against the current graph once flowsDir is a repo", async () => {
    const flow = await createFlow("My Flow");
    git(["init", "-q"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "initial"]);

    const historyRes = await app.inject({ method: "GET", url: `/api/flows/${flow.id}/git-history` });
    expect(historyRes.json().available).toBe(true);
    const commits = historyRes.json().commits;
    expect(commits).toHaveLength(1);
    expect(commits[0].message).toBe("initial");

    await app.inject({ method: "PUT", url: `/api/flows/${flow.id}`, payload: { graph: graphWithNode("a") } });

    const diffRes = await app.inject({ method: "GET", url: `/api/flows/${flow.id}/git-diff?from=${commits[0].sha}` });
    expect(diffRes.statusCode).toBe(200);
    expect(diffRes.json().diff.nodes.added.map((n: { id: string }) => n.id)).toEqual(["a"]);
  });

  it("400s git-diff without a from param", async () => {
    const flow = await createFlow("My Flow");
    const res = await app.inject({ method: "GET", url: `/api/flows/${flow.id}/git-diff` });
    expect(res.statusCode).toBe(400);
  });
});

describe("execution provenance", () => {
  it("shows which version ran and a changedSinceRun summary once the flow moves on", async () => {
    const flow = await createFlow("My Flow");
    const started = await app.inject({ method: "POST", url: `/api/flows/${flow.id}/run` });
    const { executionId } = started.json();

    const before = (await app.inject({ method: "GET", url: `/api/executions/${executionId}` })).json();
    expect(before.flowVersion.version).toBe(1);
    expect(before.changedSinceRun).toBeUndefined();

    await app.inject({ method: "PUT", url: `/api/flows/${flow.id}`, payload: { graph: graphWithNode("a") } });

    const after = (await app.inject({ method: "GET", url: `/api/executions/${executionId}` })).json();
    expect(after.changedSinceRun.semantic).toBe(true);
    expect(after.changedSinceRun.nodesChanged).toBe(1);
  });
});
