import { randomBytes } from "node:crypto";
import type { FlowGraph } from "@flowlathe/core";
import { ensureDefaultMockProvider, openDb, runMigrations, type OpenedDb } from "@flowlathe/persistence";
import { DiscordClient } from "@flowlathe/plugin-discord";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { ExecutionHub } from "../execution-hub.js";
import { SchedulerRegistry } from "../scheduler-registry.js";
import type { DiscordGateway, DiscordGatewayMessage } from "../triggers/discord-gateway.js";
import { TriggerRegistry } from "../triggers/registry.js";

class FakeGateway implements DiscordGateway {
  onMessage(_l: (m: DiscordGatewayMessage) => void): void {}
  onReady(_l: (id: string) => void): void {}
  onError(_l: (err: Error) => void): void {}
  async login(): Promise<void> {}
  async destroy(): Promise<void> {}
}

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
  const hub = new ExecutionHub();
  const triggerRegistry = new TriggerRegistry({
    db: opened.db,
    hub,
    scheduler: schedulerRegistry,
    pluginToolsets: [],
    discordClient: new DiscordClient({
      botToken: "test-token",
      fetchImpl: (async () => new Response(JSON.stringify({ id: "reply-1" }), { status: 200 })) as unknown as typeof fetch,
    }),
    discordBotToken: "test-token",
    gatewayFactory: () => new FakeGateway(),
  });
  const app = buildApp({ db: opened.db, credentialKey, schedulerRegistry, hub, triggerRegistry });
  return { app, triggerRegistry };
}

const triggerableGraph: FlowGraph = {
  nodes: [
    { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { source: "discord", testPayload: "" } },
    { id: "b", type: "prompt", position: { x: 1, y: 0 }, data: { template: "got: {{input}}", providerId: "mock", modelId: "m" } },
  ],
  edges: [{ id: "t-b", source: "t", target: "b", sourceHandle: "content", targetHandle: "input" }],
  state: [],
};

async function createFlowViaApi(app: ReturnType<typeof buildTestApp>["app"], graph: FlowGraph): Promise<string> {
  const created = await app.inject({ method: "POST", url: "/api/flows", payload: { name: "f" } });
  const flowId = (created.json() as { id: string }).id;
  await app.inject({ method: "PUT", url: `/api/flows/${flowId}`, payload: { graph } });
  return flowId;
}

describe("POST /api/triggers", () => {
  it("rejects a flow with no discord trigger node", async () => {
    const { app } = buildTestApp();
    const flowId = await createFlowViaApi(app, {
      nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "hi", providerId: "mock", modelId: "m" } }],
      edges: [],
      state: [],
    });
    const res = await app.inject({ method: "POST", url: "/api/triggers", payload: { flowId, source: "discord", channelIds: ["c1"] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('trigger node with source: "discord"');
    await app.close();
  });

  it("rejects a flow containing a pause node", async () => {
    const { app } = buildTestApp();
    const flowId = await createFlowViaApi(app, {
      nodes: [
        { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { source: "discord", testPayload: "" } },
        { id: "p", type: "pause", position: { x: 1, y: 0 }, data: { message: "" } },
      ],
      edges: [],
      state: [],
    });
    const res = await app.inject({ method: "POST", url: "/api/triggers", payload: { flowId, source: "discord", channelIds: ["c1"] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("pause or userInput");
    await app.close();
  });

  it("rejects a flow requiring an unconfigured plugin toolset", async () => {
    const { app } = buildTestApp();
    const flowId = await createFlowViaApi(app, {
      nodes: [
        { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { source: "discord", testPayload: "" } },
        {
          id: "b",
          type: "prompt",
          position: { x: 1, y: 0 },
          data: { template: "got: {{input}}", providerId: "mock", modelId: "m", enabledToolsets: ["spotify"] },
        },
      ],
      edges: [{ id: "t-b", source: "t", target: "b", sourceHandle: "content", targetHandle: "input" }],
      state: [],
    });
    const res = await app.inject({ method: "POST", url: "/api/triggers", payload: { flowId, source: "discord", channelIds: ["c1"] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("spotify");
    await app.close();
  });

  it("creates and starts a trigger for a valid graph", async () => {
    const { app, triggerRegistry } = buildTestApp();
    const flowId = await createFlowViaApi(app, triggerableGraph);
    const res = await app.inject({ method: "POST", url: "/api/triggers", payload: { flowId, source: "discord", channelIds: ["c1"] } });
    expect(res.statusCode).toBe(201);
    const trigger = res.json() as { id: string };
    expect(triggerRegistry.isActive(trigger.id)).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/triggers" });
    expect((list.json() as { id: string; active: boolean }[]).find((t) => t.id === trigger.id)?.active).toBe(true);
    await app.close();
  });
});

describe("DELETE /api/triggers/:id", () => {
  it("stops the trigger and removes it", async () => {
    const { app, triggerRegistry } = buildTestApp();
    const flowId = await createFlowViaApi(app, triggerableGraph);
    const created = await app.inject({ method: "POST", url: "/api/triggers", payload: { flowId, source: "discord", channelIds: ["c1"] } });
    const trigger = created.json() as { id: string };

    const res = await app.inject({ method: "DELETE", url: `/api/triggers/${trigger.id}` });
    expect(res.statusCode).toBe(204);
    expect(triggerRegistry.isActive(trigger.id)).toBe(false);

    const list = await app.inject({ method: "GET", url: "/api/triggers" });
    expect((list.json() as { id: string }[]).find((t) => t.id === trigger.id)).toBeUndefined();
    await app.close();
  });
});
