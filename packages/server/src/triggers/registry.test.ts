import type { FlowGraph } from "@flowlathe/core";
import {
  createFlow,
  createTrigger,
  getBlob,
  getExecution,
  listExecutionTriggers,
  listResponses,
  openDb,
  runMigrations,
  setTriggerCursor,
  sha256Of,
  type OpenedDb,
} from "@flowlathe/persistence";
import { DiscordClient } from "@flowlathe/plugin-discord";
import { MockProviderAdapter, SimpleScheduler } from "@flowlathe/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionHub } from "../execution-hub.js";
import type { DiscordGateway, DiscordGatewayFactory, DiscordGatewayMessage } from "./discord-gateway.js";
import { TriggerRegistry, validateTriggerGraph } from "./registry.js";

class FakeGateway implements DiscordGateway {
  private messageListeners: ((m: DiscordGatewayMessage) => void)[] = [];
  private readyListeners: ((id: string) => void)[] = [];
  private errorListeners: ((err: Error) => void)[] = [];
  destroyed = false;

  onMessage(listener: (m: DiscordGatewayMessage) => void): void {
    this.messageListeners.push(listener);
  }
  onReady(listener: (id: string) => void): void {
    this.readyListeners.push(listener);
  }
  onError(listener: (err: Error) => void): void {
    this.errorListeners.push(listener);
  }
  async login(): Promise<void> {
    for (const l of this.readyListeners) l("bot-user-id");
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
  emit(message: DiscordGatewayMessage): void {
    for (const l of this.messageListeners) l(message);
  }
  fail(err: Error): void {
    for (const l of this.errorListeners) l(err);
  }
}

function triggerGraph(): FlowGraph {
  return {
    nodes: [
      { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { source: "discord", testPayload: "" } },
      { id: "b", type: "prompt", position: { x: 1, y: 0 }, data: { template: "got: {{input}}", providerId: "mock", modelId: "m" } },
    ],
    edges: [{ id: "t-b", source: "t", target: "b", sourceHandle: "content", targetHandle: "input" }],
    state: [],
  };
}

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
});

afterEach(() => {
  opened.close();
  vi.restoreAllMocks();
});

function buildRegistry(gatewayFactory: DiscordGatewayFactory): TriggerRegistry {
  const hub = new ExecutionHub();
  const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 4 } });
  const restClient = new DiscordClient({ botToken: "t", fetchImpl: (async () => new Response(JSON.stringify({ id: "reply-1" }), { status: 200 })) as unknown as typeof fetch });
  return new TriggerRegistry({
    db: opened.db,
    hub,
    scheduler,
    pluginToolsets: [],
    discordClient: restClient,
    discordBotToken: "t",
    gatewayFactory,
  });
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe("TriggerRegistry (Discord)", () => {
  it("admits an allowed message into a new, seeded execution", async () => {
    const flow = createFlow(opened.db, "Triggered Flow", triggerGraph());
    const trigger = createTrigger(opened.db, {
      flowId: flow.id,
      flowVersionId: flow.flowVersionId,
      source: "discord",
      config: { channelIds: ["c1"] },
    });
    const gateway = new FakeGateway();
    const registry = buildRegistry(() => gateway);

    await registry.start(trigger);
    expect(registry.isActive(trigger.id)).toBe(true);

    gateway.emit({ id: "msg-1", channelId: "c1", authorId: "u1", authorIsBot: false, content: "hello from discord" });
    await settle();

    const provenance = listExecutionTriggers(opened.db, trigger.id);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]!.externalId).toBe("msg-1");
    const execution = getExecution(opened.db, provenance[0]!.executionId);
    expect(execution?.flowVersionId).toBe(trigger.flowVersionId);
  });

  it("sanitizes/bounds the seed but persists the raw message payload byte-identical", async () => {
    const flow = createFlow(opened.db, "Triggered Flow", triggerGraph());
    const trigger = createTrigger(opened.db, {
      flowId: flow.id,
      flowVersionId: flow.flowVersionId,
      source: "discord",
      config: { channelIds: ["c1"] },
    });
    const gateway = new FakeGateway();
    const registry = buildRegistry(() => gateway);
    await registry.start(trigger);

    const zeroWidthSpace = String.fromCharCode(0x200b);
    const rawContent = `${zeroWidthSpace}${"x".repeat(2500)}`;
    const message: DiscordGatewayMessage = { id: "msg-1", channelId: "c1", authorId: "u1", authorIsBot: false, content: rawContent };
    gateway.emit(message);
    await settle();

    const provenance = listExecutionTriggers(opened.db, trigger.id);
    expect(provenance).toHaveLength(1);
    const execution = getExecution(opened.db, provenance[0]!.executionId);
    expect(execution).toBeDefined();

    // The seed reaches the flow's prompt node clean and bounded to 2000 chars.
    const responses = listResponses(opened.db, provenance[0]!.executionId);
    const bResponse = responses.find((r) => r.nodeId === "b");
    expect(bResponse?.renderedPromptSha).toBeTruthy();
    const renderedPrompt = getBlob(opened.db, bResponse!.renderedPromptSha!)?.toString("utf-8");
    expect(renderedPrompt).toBe(`got: ${"x".repeat(2000)}`);

    // The persisted execution_triggers payload is byte-identical to the raw (unsanitized) message.
    const expectedSha = sha256Of(Buffer.from(JSON.stringify(message), "utf-8"));
    const persisted = getBlob(opened.db, expectedSha)?.toString("utf-8");
    expect(persisted).toBe(JSON.stringify(message));
  });

  it("ignores a message on a channel not in the trigger's allowlist", async () => {
    const flow = createFlow(opened.db, "Triggered Flow", triggerGraph());
    const trigger = createTrigger(opened.db, {
      flowId: flow.id,
      flowVersionId: flow.flowVersionId,
      source: "discord",
      config: { channelIds: ["c1"] },
    });
    const gateway = new FakeGateway();
    const registry = buildRegistry(() => gateway);
    await registry.start(trigger);

    gateway.emit({ id: "msg-1", channelId: "not-allowed", authorId: "u1", authorIsBot: false, content: "hi" });
    await settle();

    expect(listExecutionTriggers(opened.db, trigger.id)).toHaveLength(0);
  });

  it("ignores the bot's own messages (self-loop guard)", async () => {
    const flow = createFlow(opened.db, "Triggered Flow", triggerGraph());
    const trigger = createTrigger(opened.db, {
      flowId: flow.id,
      flowVersionId: flow.flowVersionId,
      source: "discord",
      config: { channelIds: ["c1"] },
    });
    const gateway = new FakeGateway();
    const registry = buildRegistry(() => gateway);
    await registry.start(trigger); // login() fires onReady with "bot-user-id"

    gateway.emit({ id: "msg-1", channelId: "c1", authorId: "bot-user-id", authorIsBot: true, content: "echo" });
    await settle();

    expect(listExecutionTriggers(opened.db, trigger.id)).toHaveLength(0);
  });

  it("a redelivered message id creates no second execution", async () => {
    const flow = createFlow(opened.db, "Triggered Flow", triggerGraph());
    const trigger = createTrigger(opened.db, {
      flowId: flow.id,
      flowVersionId: flow.flowVersionId,
      source: "discord",
      config: { channelIds: ["c1"] },
    });
    const gateway = new FakeGateway();
    const registry = buildRegistry(() => gateway);
    await registry.start(trigger);

    gateway.emit({ id: "msg-1", channelId: "c1", authorId: "u1", authorIsBot: false, content: "hello" });
    await settle();
    gateway.emit({ id: "msg-1", channelId: "c1", authorId: "u1", authorIsBot: false, content: "hello" });
    await settle();

    expect(listExecutionTriggers(opened.db, trigger.id)).toHaveLength(1);
  });

  it("stop() destroys the gateway and marks the trigger inactive", async () => {
    const flow = createFlow(opened.db, "Triggered Flow", triggerGraph());
    const trigger = createTrigger(opened.db, {
      flowId: flow.id,
      flowVersionId: flow.flowVersionId,
      source: "discord",
      config: { channelIds: ["c1"] },
    });
    const gateway = new FakeGateway();
    const registry = buildRegistry(() => gateway);
    await registry.start(trigger);
    await registry.stop(trigger.id);
    expect(gateway.destroyed).toBe(true);
    expect(registry.isActive(trigger.id)).toBe(false);
  });

  it("recovers a missed message from a stored cursor on reconnect", async () => {
    const flow = createFlow(opened.db, "Triggered Flow", triggerGraph());
    const trigger = createTrigger(opened.db, {
      flowId: flow.id,
      flowVersionId: flow.flowVersionId,
      source: "discord",
      config: { channelIds: ["c1"] },
    });
    setTriggerCursor(opened.db, trigger.id, "c1", "1000000000000000000");

    const recentSnowflake = String((BigInt(Date.now() - 1420070400000) << 22n) | 1n);
    const hub = new ExecutionHub();
    const scheduler = new SimpleScheduler({ mock: { adapter: new MockProviderAdapter(), maxParallel: 4 } });
    const restClient = new DiscordClient({
      botToken: "t",
      fetchImpl: (async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/messages")) {
          return new Response(
            JSON.stringify([
              { id: recentSnowflake, author: { id: "u1", username: "alice", bot: false }, content: "missed message", timestamp: "t" },
            ]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ id: "reply-1" }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const registry = new TriggerRegistry({
      db: opened.db,
      hub,
      scheduler,
      pluginToolsets: [],
      discordClient: restClient,
      discordBotToken: "t",
      gatewayFactory: () => new FakeGateway(),
    });

    await registry.start(trigger);
    await settle();

    const provenance = listExecutionTriggers(opened.db, trigger.id);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]!.externalId).toBe(recentSnowflake);
  });
});

describe("validateTriggerGraph", () => {
  it("requires at least one discord-sourced trigger node", () => {
    const graph: FlowGraph = {
      nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "hi", providerId: "mock", modelId: "m" } }],
      edges: [],
      state: [],
    };
    const problems = validateTriggerGraph(graph, []);
    expect(problems.some((p) => p.message.includes('trigger node with source: "discord"'))).toBe(true);
  });

  it("rejects a graph containing a pause or userInput node", () => {
    const graph: FlowGraph = {
      nodes: [
        { id: "t", type: "trigger", position: { x: 0, y: 0 }, data: { source: "discord", testPayload: "" } },
        { id: "p", type: "pause", position: { x: 1, y: 0 }, data: { message: "" } },
      ],
      edges: [],
      state: [],
    };
    const problems = validateTriggerGraph(graph, []);
    expect(problems.some((p) => p.message.includes("pause or userInput"))).toBe(true);
  });

  it("accepts a valid triggerable graph", () => {
    const problems = validateTriggerGraph(triggerGraph(), []);
    expect(problems).toEqual([]);
  });
});
