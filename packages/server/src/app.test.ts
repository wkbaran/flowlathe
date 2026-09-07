import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type OpenedDb,
  contentHashOf,
  ensureDefaultMockProvider,
  listRunEventsSince,
  openDb,
  runMigrations,
} from "@flowlathe/persistence";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { SchedulerRegistry } from "./scheduler-registry.js";

let opened: OpenedDb;
let app: ReturnType<typeof buildApp>;
let flowsDir: string;

beforeEach(async () => {
  opened = openDb(":memory:");
  runMigrations(opened);
  ensureDefaultMockProvider(opened.db);
  const credentialKey = randomBytes(32);
  const schedulerRegistry = new SchedulerRegistry(opened.db, credentialKey);
  flowsDir = await mkdtemp(join(tmpdir(), "flowlathe-server-flows-"));
  app = buildApp({ db: opened.db, credentialKey, schedulerRegistry, flowsDir });
});

afterEach(async () => {
  await app.close();
  opened.close();
  await rm(flowsDir, { recursive: true, force: true });
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
    expect(fetched.json().graph).toEqual({ ...graph, state: [] });
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

  it("writes a canonical .flow file to disk on create and on save", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/api/flows", payload: { name: "My Flow" } })
    ).json();
    expect(await readFile(join(flowsDir, `${created.id}.flow`), "utf8")).toContain('flow "My Flow"');

    const graph = { nodes: [{ id: "a", type: "prompt", position: { x: 1, y: 2 }, data: { template: "hi", providerId: "mock", modelId: "m" } }], edges: [] };
    await app.inject({ method: "PUT", url: `/api/flows/${created.id}`, payload: { graph } });
    expect(await readFile(join(flowsDir, `${created.id}.flow`), "utf8")).toContain("node a: prompt");
  });

  it("PUT with a stale ifMatch is rejected with 409 and the on-disk text", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/api/flows", payload: { name: "My Flow" } })
    ).json();
    // An external edit — bypassing the API entirely, like an editor or `git checkout` would.
    await writeFile(join(flowsDir, `${created.id}.flow`), 'flow "My Flow (edited externally)" {\n}\n');

    const graph = { nodes: [], edges: [] };
    const res = await app.inject({
      method: "PUT",
      url: `/api/flows/${created.id}`,
      payload: { graph, ifMatch: "stale-hash-the-canvas-loaded" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().currentText).toContain("edited externally");
  });

  it("PUT with the matching ifMatch succeeds", async () => {
    const created = (
      await app.inject({ method: "POST", url: "/api/flows", payload: { name: "My Flow" } })
    ).json();
    const currentHash = contentHashOf(await readFile(join(flowsDir, `${created.id}.flow`), "utf8"));

    const graph = { nodes: [], edges: [] };
    const res = await app.inject({
      method: "PUT",
      url: `/api/flows/${created.id}`,
      payload: { graph, ifMatch: currentHash },
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("paste-to-import", () => {
  const TEXT = `flow "Imported Flow" {
  node a: prompt @(0, 0) {
    template = "hi"
    providerId = "mock"
    modelId = "m"
  }
}
`;

  it("creates a new flow from pasted DSL text", async () => {
    const res = await app.inject({ method: "POST", url: "/api/flows/import", payload: { text: TEXT } });
    expect(res.statusCode).toBe(201);
    const flow = res.json();
    expect(flow.name).toBe("Imported Flow");
    expect(flow.graph.nodes).toHaveLength(1);
    expect(await readFile(join(flowsDir, `${flow.id}.flow`), "utf8")).toBe(TEXT);
  });

  it("re-importing the same name saves a new version of the same flow, not a duplicate", async () => {
    const first = (await app.inject({ method: "POST", url: "/api/flows/import", payload: { text: TEXT } })).json();
    const editedText = TEXT.replace('template = "hi"', 'template = "hi again"');
    const res = await app.inject({ method: "POST", url: "/api/flows/import", payload: { text: editedText } });
    expect(res.statusCode).toBe(200);
    const second = res.json();
    expect(second.id).toBe(first.id);
    expect(second.version).toBe(first.version + 1);

    const all = (await app.inject({ method: "GET", url: "/api/flows" })).json();
    expect(all).toHaveLength(1);
  });

  it("rejects unparseable text", async () => {
    const res = await app.inject({ method: "POST", url: "/api/flows/import", payload: { text: "flow ??? {" } });
    expect(res.statusCode).toBe(400);
  });

  it("rejects text that parses but fails graph validation", async () => {
    const invalid = `flow "Bad" {
  node a: prompt @(0, 0) {
    template = "{{input}}"
    providerId = "mock"
    modelId = "m"
  }
}
`;
    const res = await app.inject({ method: "POST", url: "/api/flows/import", payload: { text: invalid } });
    expect(res.statusCode).toBe(400);
  });
});

async function createTwoNodeFlow(): Promise<string> {
  const created = (await app.inject({ method: "POST", url: "/api/flows", payload: { name: "Chain" } })).json();
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

describe("run + export", () => {
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

async function createFlowRequiringToolset(toolset: string): Promise<string> {
  const created = (await app.inject({ method: "POST", url: "/api/flows", payload: { name: "Needs plugin" } })).json();
  const graph = {
    nodes: [
      {
        id: "a",
        type: "prompt",
        position: { x: 0, y: 0 },
        data: { template: "hi", providerId: "mock", modelId: "m", enabledToolsets: [toolset] },
      },
    ],
    edges: [],
  };
  await app.inject({ method: "PUT", url: `/api/flows/${created.id}`, payload: { graph } });
  return created.id;
}

describe("workflow dependency gate", () => {
  it("refuses to run a flow that requires a toolset nothing has registered", async () => {
    const flowId = await createFlowRequiringToolset("spotify");
    const res = await app.inject({ method: "POST", url: `/api/flows/${flowId}/run` });
    expect(res.statusCode).toBe(409);
    expect(res.json().missing).toEqual([{ toolset: "spotify", reason: expect.stringContaining("not configured") }]);
  });

  it("refuses to start a step session for the same reason", async () => {
    const flowId = await createFlowRequiringToolset("spotify");
    const res = await app.inject({ method: "POST", url: `/api/flows/${flowId}/step-start` });
    expect(res.statusCode).toBe(409);
  });

  it("does not gate a flow requiring a toolset that IS registered", async () => {
    const credentialKey = randomBytes(32);
    const schedulerRegistry = new SchedulerRegistry(opened.db, credentialKey);
    const appWithPlugin = buildApp({
      db: opened.db,
      credentialKey,
      schedulerRegistry,
      pluginToolsets: [
        {
          toolset: "custom",
          spec: { name: "custom_tool", description: "d", parameters: { type: "object", properties: {} } },
          handler: () => "ok",
        },
      ],
    });
    const flowId = await createFlowRequiringToolset("custom");
    const res = await appWithPlugin.inject({ method: "POST", url: `/api/flows/${flowId}/run` });
    expect(res.statusCode).toBe(202);
    await appWithPlugin.close();
  });
});

async function createFlowWithBodylessMap(): Promise<string> {
  const created = (await app.inject({ method: "POST", url: "/api/flows", payload: { name: "Bodyless map" } })).json();
  const graph = {
    nodes: [
      {
        id: "m",
        type: "map",
        position: { x: 0, y: 0 },
        data: { itemsTemplate: '["x"]', itemPortName: "item", maxConcurrency: 1, maxItems: 10 },
      },
    ],
    edges: [],
  };
  await app.inject({ method: "PUT", url: `/api/flows/${created.id}`, payload: { graph } });
  return created.id;
}

describe("graph validation gate", () => {
  it("refuses to run a flow whose Loop/Map node has no body node", async () => {
    const flowId = await createFlowWithBodylessMap();
    const res = await app.inject({ method: "POST", url: `/api/flows/${flowId}/run` });
    expect(res.statusCode).toBe(409);
    expect(res.json().problems).toEqual([expect.stringContaining("has no body node")]);
  });

  it("refuses to start a step session for the same reason", async () => {
    const flowId = await createFlowWithBodylessMap();
    const res = await app.inject({ method: "POST", url: `/api/flows/${flowId}/step-start` });
    expect(res.statusCode).toBe(409);
    expect(res.json().problems).toEqual([expect.stringContaining("has no body node")]);
  });
});

async function waitForFinished(executionId: string): Promise<void> {
  let status: string | undefined;
  for (let i = 0; i < 50 && status !== "finished"; i++) {
    const res = await app.inject({ method: "GET", url: `/api/executions/${executionId}` });
    status = res.json().execution.status;
    if (status !== "finished") await new Promise((r) => setTimeout(r, 10));
  }
  expect(status).toBe("finished");
}

describe("state", () => {
  it("a prompt's write_state tool call is applied with the entry's merge rule and observable via the state endpoint", async () => {
    const created = (await app.inject({ method: "POST", url: "/api/flows", payload: { name: "Stateful" } })).json();
    const graph = {
      nodes: [
        {
          id: "a",
          type: "prompt",
          position: { x: 0, y: 0 },
          data: {
            template: 'CALL_TOOL: write_state {"entry":"notes","value":"hello"}',
            providerId: "mock",
            modelId: "m",
            enableStateTools: true,
          },
        },
      ],
      edges: [],
      state: [{ name: "notes", type: "string", merge: "append" }],
    };
    await app.inject({ method: "PUT", url: `/api/flows/${created.id}`, payload: { graph } });

    const started = await app.inject({ method: "POST", url: `/api/flows/${created.id}/run` });
    const { executionId } = started.json();
    await waitForFinished(executionId);

    const execution = (await app.inject({ method: "GET", url: `/api/executions/${executionId}` })).json().execution;
    const state = (
      await app.inject({ method: "GET", url: `/api/executions/${executionId}/state?branchId=${execution.rootBranchId}` })
    ).json();
    expect(state).toEqual({ notes: ["hello"] });

    const lineage = (
      await app.inject({
        method: "GET",
        url: `/api/executions/${executionId}/state-lineage?branchId=${execution.rootBranchId}`,
      })
    ).json();
    expect(lineage).toEqual([]); // nothing else read "notes" in this flow
  });
});

describe("gate + automatic context accumulation", () => {
  it("a gate's compaction settings apply once a map body's own context crosses the threshold", async () => {
    const created = (await app.inject({ method: "POST", url: "/api/flows", payload: { name: "Gated" } })).json();
    const graph = {
      nodes: [
        { id: "seed", type: "prompt", position: { x: 0, y: 0 }, data: { template: "seed", providerId: "mock", modelId: "m" } },
        {
          id: "g",
          type: "gate",
          position: { x: 1, y: 0 },
          data: { compactionMethod: "drop-oldest-half", compactionThreshold: { kind: "fixed", tokens: 1 } },
        },
        {
          id: "m",
          type: "map",
          position: { x: 2, y: 0 },
          data: { itemsTemplate: '["{{marker}}","b"]', itemPortName: "item", maxConcurrency: 1, maxItems: 10 },
        },
        {
          id: "body",
          type: "prompt",
          position: { x: 3, y: 0 },
          data: { template: "{{item}}", providerId: "mock", modelId: "m" },
          parentId: "m",
        },
      ],
      edges: [
        { id: "e1", source: "seed", target: "g", targetHandle: "input" },
        { id: "e2", source: "g", target: "m", targetHandle: "marker" },
      ],
      state: [],
    };
    await app.inject({ method: "PUT", url: `/api/flows/${created.id}`, payload: { graph } });

    const started = await app.inject({ method: "POST", url: `/api/flows/${created.id}/run` });
    const { executionId } = started.json();
    await waitForFinished(executionId);

    const events = listRunEventsSince(opened.db, executionId, 0).map((row) => row.payload as { kind: string });

    expect(events.some((e) => e.kind === "llm_config_set")).toBe(true);
    const compaction = events.find((e) => e.kind === "context_compacted") as
      | { method: string; beforeMessages: unknown[]; afterMessages: unknown[] }
      | undefined;
    expect(compaction).toBeTruthy();
    expect(compaction!.method).toBe("drop-oldest-half");
    expect(compaction!.beforeMessages.length).toBeGreaterThan(compaction!.afterMessages.length);

    const appendedForBody = events.filter(
      (e) => e.kind === "context_appended" && (e as unknown as { nodeId: string }).nodeId.startsWith("body@m:"),
    );
    expect(appendedForBody.length).toBe(2); // one per map iteration, same underlying "body" node
  });
});

describe("an execution's flow, as text, survives the flow file being deleted", () => {
  it("GET /api/executions/:id/flow-source keeps working after the .flow file is gone", async () => {
    const flowId = await createTwoNodeFlow();
    const started = await app.inject({ method: "POST", url: `/api/flows/${flowId}/step-start` });
    const { executionId } = started.json();

    const before = await app.inject({ method: "GET", url: `/api/executions/${executionId}/flow-source` });
    expect(before.statusCode).toBe(200);
    expect(before.json().sourceText).toContain(`flow "Chain"`);
    expect(before.json().graph.nodes).toHaveLength(2);

    await rm(join(flowsDir, `${flowId}.flow`));

    const after = await app.inject({ method: "GET", url: `/api/executions/${executionId}/flow-source` });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual(before.json());
  });
});

describe("step debugging", () => {
  it("advances one node per step, exposing the new snapshot each time", async () => {
    const flowId = await createTwoNodeFlow();
    const started = await app.inject({ method: "POST", url: `/api/flows/${flowId}/step-start` });
    expect(started.statusCode).toBe(201);
    const { executionId, branchId, snapshotId: initialSnapshotId } = started.json();

    const step1 = (
      await app.inject({ method: "POST", url: `/api/executions/${executionId}/step`, payload: { branchId } })
    ).json();
    expect(step1).toMatchObject({ done: false, nodeId: "a" });
    expect(step1.snapshotId).not.toBe(initialSnapshotId);

    const step2 = (
      await app.inject({ method: "POST", url: `/api/executions/${executionId}/step`, payload: { branchId } })
    ).json();
    expect(step2).toMatchObject({ done: false, nodeId: "b" });

    const step3 = (
      await app.inject({ method: "POST", url: `/api/executions/${executionId}/step`, payload: { branchId } })
    ).json();
    expect(step3).toMatchObject({ done: true });

    const log = (await app.inject({ method: "GET", url: `/api/executions/${executionId}?branchId=${branchId}` })).json();
    expect(log.responses.map((r: { nodeId: string }) => r.nodeId).sort()).toEqual(["a", "b"]);
  });

  it("step-back forks a new branch, leaving the original branch's log intact", async () => {
    const flowId = await createTwoNodeFlow();
    const { executionId, branchId: rootBranchId } = (
      await app.inject({ method: "POST", url: `/api/flows/${flowId}/step-start` })
    ).json();

    const step1 = (
      await app.inject({
        method: "POST",
        url: `/api/executions/${executionId}/step`,
        payload: { branchId: rootBranchId },
      })
    ).json();
    const step2 = (
      await app.inject({
        method: "POST",
        url: `/api/executions/${executionId}/step`,
        payload: { branchId: rootBranchId },
      })
    ).json();
    expect(step2.nodeId).toBe("b");

    // step back to right after "a" ran, before "b" did
    const forked = (
      await app.inject({
        method: "POST",
        url: `/api/executions/${executionId}/step-back`,
        payload: { snapshotId: step1.snapshotId },
      })
    ).json();
    expect(forked.branchId).not.toBe(rootBranchId);

    // stepping the fork re-runs "b" on the NEW branch
    const forkedStep = (
      await app.inject({
        method: "POST",
        url: `/api/executions/${executionId}/step`,
        payload: { branchId: forked.branchId },
      })
    ).json();
    expect(forkedStep.nodeId).toBe("b");

    const branches = (await app.inject({ method: "GET", url: `/api/executions/${executionId}/branches` })).json();
    expect(branches.map((b: { id: string }) => b.id).sort()).toEqual([rootBranchId, forked.branchId].sort());

    // the original branch's log is untouched: still exactly the two responses from stepping it directly
    const originalLog = (
      await app.inject({ method: "GET", url: `/api/executions/${executionId}?branchId=${rootBranchId}` })
    ).json();
    expect(originalLog.responses.map((r: { nodeId: string }) => r.nodeId).sort()).toEqual(["a", "b"]);

    const forkedLog = (
      await app.inject({ method: "GET", url: `/api/executions/${executionId}?branchId=${forked.branchId}` })
    ).json();
    expect(forkedLog.responses.map((r: { nodeId: string }) => r.nodeId)).toEqual(["b"]);
  });

  it("resolves node b's step from the CURRENT .flow file, not the version pinned at step-start (PLAN-FLOW-DSL.md S3)", async () => {
    const flowId = await createTwoNodeFlow();
    const { executionId, branchId } = (
      await app.inject({ method: "POST", url: `/api/flows/${flowId}/step-start` })
    ).json();

    // Step node "a" before touching the file at all — this pins flowVersionId to the version
    // active when stepping began, exactly like CLAUDE.md's step-mode note describes.
    await app.inject({ method: "POST", url: `/api/executions/${executionId}/step`, payload: { branchId } });

    // Now edit the flow FILE directly, bypassing the API entirely — the same thing an editor,
    // `flowlathe fmt`, or a `git checkout` would do. Only node "b"'s template changes.
    const editedText = `flow "Chain" {
  node a: prompt @(0, 0) {
    template = "start"
    providerId = "mock"
    modelId = "m"
  }

  node b: prompt @(1, 0) {
    template = "EDITED: {{input}}"
    providerId = "mock"
    modelId = "m"
  }

  a.output -> b.input
}
`;
    await writeFile(join(flowsDir, `${flowId}.flow`), editedText);

    const step2 = (
      await app.inject({ method: "POST", url: `/api/executions/${executionId}/step`, payload: { branchId } })
    ).json();
    expect(step2).toMatchObject({ done: false, nodeId: "b" });

    const events = listRunEventsSince(opened.db, executionId, 0).map(
      (row) => row.payload as { kind: string; nodeId?: string; renderedPrompt?: string },
    );
    const bFinished = events.find((e) => e.kind === "node_finished" && e.nodeId === "b");
    expect(bFinished?.renderedPrompt).toContain("EDITED:");
  });
});

describe("host allowlist (PLAN-NETWORK-POSTURE.md)", () => {
  it("allows a default inject (light-my-request's default Host, already loopback)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/flows" });
    expect(res.statusCode).not.toBe(403);
  });

  it("rejects a foreign Host header on an ordinary route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/flows",
      headers: { host: "evil.example:4310" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a foreign Host header on the SSE events route before the handler hijacks the reply", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/executions/does-not-exist/events",
      headers: { host: "evil.example:4310" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("rejects a foreign Host on the SPA fallback instead of serving index.html", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "flowlathe-server-static-"));
    await writeFile(join(staticRoot, "index.html"), "<html>spa</html>");
    const staticOpened = openDb(":memory:");
    runMigrations(staticOpened);
    ensureDefaultMockProvider(staticOpened.db);
    const staticApp = buildApp({
      db: staticOpened.db,
      credentialKey: randomBytes(32),
      schedulerRegistry: new SchedulerRegistry(staticOpened.db, randomBytes(32)),
      staticRoot,
    });
    try {
      const res = await staticApp.inject({ method: "GET", url: "/", headers: { host: "evil.example" } });
      expect(res.statusCode).toBe(403);
    } finally {
      await staticApp.close();
      staticOpened.close();
      await rm(staticRoot, { recursive: true, force: true });
    }
  });

  it("honors an explicit allowedHosts option", async () => {
    const customOpened = openDb(":memory:");
    runMigrations(customOpened);
    ensureDefaultMockProvider(customOpened.db);
    const customApp = buildApp({
      db: customOpened.db,
      credentialKey: randomBytes(32),
      schedulerRegistry: new SchedulerRegistry(customOpened.db, randomBytes(32)),
      allowedHosts: ["flowlathe.lan"],
    });
    try {
      const allowed = await customApp.inject({
        method: "GET",
        url: "/api/flows",
        headers: { host: "flowlathe.lan" },
      });
      expect(allowed.statusCode).not.toBe(403);

      const stillDefaultDenied = await customApp.inject({
        method: "GET",
        url: "/api/flows",
        headers: { host: "127.0.0.1" },
      });
      expect(stillDefaultDenied.statusCode).toBe(403);
    } finally {
      await customApp.close();
      customOpened.close();
    }
  });
});
