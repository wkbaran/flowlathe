import {
  findMissingToolsets,
  requiredToolsets,
  validateGraph,
  type FlowGraph,
  type FlowNode,
  type Scheduler,
  type ToolRegistration,
} from "@flowlathe/core";
import { registry } from "@flowlathe/interpreter";
import {
  claimExecutionTrigger,
  executionTriggerExistsForExternalId,
  getGraphForFlowVersion,
  setTriggerCursor,
  type Db,
  type TriggerRecord,
} from "@flowlathe/persistence";
import type { DiscordClient } from "@flowlathe/plugin-discord";
import type { ExecutionHub } from "../execution-hub.js";
import { runFlow } from "../executor.js";
import type { DiscordGatewayFactory } from "./discord-gateway.js";
import { DiscordTriggerSource, type DiscordGatewayMessage } from "./discord.js";

/** Mirrors `routes/flows.ts`'s own `portsOf` (itself mirroring `run-graph.ts`'s) — needed for
 *  `validateGraph`'s port-level R6/R7 rules, which need each node kind's port declarations. */
function portsOf(node: FlowNode): string[] {
  const data = registry[node.type].schema.parse(node.data) as Record<string, unknown>;
  return registry[node.type].inputPorts({ id: node.id, ...data }).map((p) => p.name);
}

export interface TriggerRegistrationProblem {
  message: string;
}

/**
 * Registration-time validation (PLAN-INTEGRATIONS.md §7.3), reused by both the `/api/triggers`
 * route (to 409 before ever starting a gateway connection) and available for a future "validate
 * before enabling" UI affordance. Returns every problem found, not just the first, so an operator
 * fixing a trigger doesn't have to resubmit repeatedly to discover the next one.
 */
export function validateTriggerGraph(graph: FlowGraph, pluginToolsets: ToolRegistration[]): TriggerRegistrationProblem[] {
  const problems: TriggerRegistrationProblem[] = [];

  const structural = validateGraph(graph, { portsOf });
  for (const p of structural) problems.push({ message: p });

  const missing = findMissingToolsets(pluginToolsets, requiredToolsets(graph));
  for (const m of missing) problems.push({ message: `plugin toolset "${m.toolset}" is not usable: ${m.reason}` });

  const discordTriggerNodes = graph.nodes.filter((n) => n.type === "trigger" && (n.data as { source?: string })["source"] === "discord");
  if (discordTriggerNodes.length === 0) {
    problems.push({ message: 'the graph must contain at least one trigger node with source: "discord"' });
  }

  const blockingKinds = graph.nodes.filter((n) => n.type === "pause" || n.type === "userInput");
  if (blockingKinds.length > 0) {
    problems.push({
      message:
        "a triggered (headless) flow can't contain a pause or userInput node — nothing can answer it, and the " +
        "execution would sit in awaiting_input forever",
    });
  }

  return problems;
}

export interface TriggerRegistryDeps {
  db: Db;
  hub: ExecutionHub;
  scheduler: Scheduler;
  pluginToolsets: ToolRegistration[];
  /** `undefined` when Discord isn't configured (no `DISCORD_BOT_TOKEN`) — starting a Discord
   *  trigger then throws immediately, same as `findMissingToolsets` would report at the route
   *  layer. */
  discordClient: DiscordClient | undefined;
  discordBotToken: string | undefined;
  /** Test seam — threaded through to every `DiscordTriggerSource` this registry creates. */
  gatewayFactory?: DiscordGatewayFactory;
  /** Default 4 — a triggered execution is otherwise unbounded in how many can run at once. */
  maxConcurrentExecutions?: number;
  recoveryWindowSeconds?: number;
  recoveryLimit?: number;
}

/**
 * Owns every live trigger source (currently just Discord) for the server's lifetime: starting
 * one on `start()`, routing its admitted messages through one shared pipeline — channel
 * allowlist and the self-message guard already applied by `DiscordTriggerSource` itself; this
 * class owns the dedupe **claim**, the concurrency cap, seeding, starting the run, and posting
 * the result back — and stopping every source on `stopAll()` (called from `index.ts` alongside
 * `app.close()`).
 */
export class TriggerRegistry {
  private readonly sources = new Map<string, DiscordTriggerSource>();
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: TriggerRegistryDeps) {}

  async start(trigger: TriggerRecord): Promise<void> {
    if (trigger.source !== "discord") {
      throw new Error(`unknown trigger source "${trigger.source}"`);
    }
    if (!this.deps.discordClient || !this.deps.discordBotToken) {
      throw new Error("Discord is not configured (set DISCORD_BOT_TOKEN)");
    }

    const source = new DiscordTriggerSource({
      db: this.deps.db,
      botToken: this.deps.discordBotToken,
      ...(this.deps.gatewayFactory ? { gatewayFactory: this.deps.gatewayFactory } : {}),
      restClient: this.deps.discordClient,
      ...(this.deps.recoveryWindowSeconds !== undefined ? { recoveryWindowSeconds: this.deps.recoveryWindowSeconds } : {}),
      ...(this.deps.recoveryLimit !== undefined ? { recoveryLimit: this.deps.recoveryLimit } : {}),
      onMessage: (t, message) => this.admitMessage(t, message),
    });
    await source.start(trigger);
    this.sources.set(trigger.id, source);
  }

  async stop(triggerId: string): Promise<void> {
    const source = this.sources.get(triggerId);
    if (!source) return;
    await source.stop();
    this.sources.delete(triggerId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.sources.keys()].map((id) => this.stop(id)));
  }

  isActive(triggerId: string): boolean {
    return this.sources.has(triggerId);
  }

  /**
   * The shared admission pipeline every message — live gateway event or a recovered (missed)
   * one — goes through identically (PLAN-INTEGRATIONS.md §7.6): a fast non-claiming dedupe
   * check, a concurrency cap, the graph-pinned-version resolve, seeding every Discord-sourced
   * trigger node with the message, starting the run, and (once it settles) posting the result
   * back to the originating channel. The cursor advances on successful *admission*, independent
   * of whether the run itself later succeeds or fails.
   */
  private admitMessage(trigger: TriggerRecord, message: DiscordGatewayMessage): void {
    if (executionTriggerExistsForExternalId(this.deps.db, message.id)) return;
    if (this.inFlight.size >= (this.deps.maxConcurrentExecutions ?? 4)) {
      console.warn(`[discord-trigger "${trigger.id}"] dropping message ${message.id}: max concurrent triggered executions reached`);
      return;
    }

    const graph = getGraphForFlowVersion(this.deps.db, trigger.flowVersionId);
    if (!graph) {
      console.error(`[discord-trigger "${trigger.id}"] pinned flow version ${trigger.flowVersionId} no longer exists`);
      return;
    }

    const seed: Record<string, Record<string, string>> = {};
    for (const node of graph.nodes) {
      if (node.type === "trigger" && (node.data as { source?: string })["source"] === "discord") {
        seed[node.id] = { content: message.content, authorId: message.authorId, channelId: message.channelId, messageId: message.id };
      }
    }

    const { executionId } = runFlow({
      db: this.deps.db,
      hub: this.deps.hub,
      scheduler: this.deps.scheduler,
      flowVersionId: trigger.flowVersionId,
      graph,
      pluginToolsets: this.deps.pluginToolsets,
      seed,
    });

    // The claim happens after starting the execution (the row it references must exist first —
    // execution_triggers.execution_id is a real FK) — a claim lost to a very tight race against
    // the recovery scan just means one extra, harmless execution ran; the non-claiming check
    // above already makes that race rare in practice.
    const claimed = claimExecutionTrigger(this.deps.db, {
      executionId,
      triggerId: trigger.id,
      source: "discord",
      externalId: message.id,
      payload: Buffer.from(JSON.stringify(message), "utf-8"),
    });
    if (!claimed) {
      console.warn(`[discord-trigger "${trigger.id}"] lost the dedupe race for message ${message.id} (execution ${executionId} still ran)`);
    }

    setTriggerCursor(this.deps.db, trigger.id, message.channelId, message.id);

    this.inFlight.add(executionId);
    const unsubscribe = this.deps.hub.subscribe(executionId, (event) => {
      if (event.kind === "run_finished" || event.kind === "run_failed") {
        this.inFlight.delete(executionId);
        unsubscribe();
        void this.postResult(trigger, message.channelId, event);
      }
    });
  }

  private async postResult(
    trigger: TriggerRecord,
    channelId: string,
    event: { kind: string; payload: unknown },
  ): Promise<void> {
    if (!this.deps.discordClient) return;
    try {
      if (event.kind === "run_finished") {
        const outputs = (event.payload as { outputs?: Record<string, unknown> }).outputs ?? {};
        const summary = Object.values(outputs).find((v) => typeof v === "string") as string | undefined;
        await this.deps.discordClient.sendMessage(channelId, summary ?? "(flow finished with no text output)");
      } else if (event.kind === "run_failed") {
        const error = (event.payload as { error?: string }).error ?? "unknown error";
        await this.deps.discordClient.sendMessage(channelId, `⚠️ flow failed: ${error}`);
      }
    } catch (err) {
      console.error(`[discord-trigger "${trigger.id}"] failed to post result back to channel ${channelId}: ${(err as Error).message}`);
    }
  }
}
