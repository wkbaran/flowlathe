import type { DiscordClient } from "@flowlathe/plugin-discord";
import { getTriggerCursor, type Db, type TriggerRecord } from "@flowlathe/persistence";
import { createDiscordJsGateway, type DiscordGateway, type DiscordGatewayFactory, type DiscordGatewayMessage } from "./discord-gateway.js";

export type { DiscordGatewayMessage };

const PRIVILEGED_INTENTS_GUIDANCE =
  'This is almost always caused by the "MESSAGE CONTENT INTENT" privileged Gateway Intent not ' +
  "being enabled for this bot application. Fix: open https://discord.com/developers/applications, " +
  'select your application, open "Bot" in the sidebar, and enable "MESSAGE CONTENT INTENT" under ' +
  '"Privileged Gateway Intents".';

/** Privileged-intent rejection is the single most common Discord-bot setup failure, and a bare
 *  connection error wastes an hour tracking it down — detect the likely case (heuristically, by
 *  message content, since discord.js doesn't expose a stable typed error code across versions
 *  for this) and append the exact portal path rather than a generic "connection failed". */
export function describeDiscordGatewayError(err: Error): string {
  const looksLikeIntentsIssue = /intent|disallowed/i.test(err.message);
  return looksLikeIntentsIssue ? `${err.message}\n\n${PRIVILEGED_INTENTS_GUIDANCE}` : err.message;
}

export interface DiscordTriggerConfig {
  channelIds: string[];
}

export interface DiscordTriggerSourceOptions {
  db: Db;
  botToken: string;
  gatewayFactory?: DiscordGatewayFactory;
  /** REST client used only for the post-reconnect recovery scan (a GET, not a send) — reuses
   *  @flowlathe/plugin-discord's client rather than a second HTTP implementation. */
  restClient: DiscordClient;
  recoveryWindowSeconds?: number;
  recoveryLimit?: number;
  /** Called for every message this source admits past the channel allowlist and self-message
   *  guard — both a live gateway event and a recovered (missed) message go through this exact
   *  same callback, per PLAN-INTEGRATIONS.md §7.6's "identical admission path" requirement. The
   *  caller (TriggerRegistry) owns the dedupe **claim** (`claimExecutionTrigger`) and everything
   *  downstream of it — this class only ever gates on channel allowlist and the self-loop guard. */
  onMessage: (trigger: TriggerRecord, message: DiscordGatewayMessage) => void;
}

/** One Discord gateway connection for one trigger. Gateway wiring is behind the `DiscordGateway`
 *  seam (discord-gateway.ts) specifically so this class can be driven by an injected fake event
 *  emitter in tests — see PLAN-INTEGRATIONS.md §8. */
export class DiscordTriggerSource {
  private gateway: DiscordGateway | undefined;
  private botUserId: string | undefined;

  constructor(private readonly opts: DiscordTriggerSourceOptions) {}

  async start(trigger: TriggerRecord): Promise<void> {
    const allowedChannels = new Set((trigger.configJson as DiscordTriggerConfig).channelIds ?? []);
    const factory = this.opts.gatewayFactory ?? createDiscordJsGateway;
    const gateway = factory(this.opts.botToken);
    this.gateway = gateway;

    gateway.onReady((botUserId) => {
      this.botUserId = botUserId;
      void this.recoverMissedMessages(trigger, allowedChannels);
    });
    gateway.onError((err) => {
      console.error(`[discord-trigger "${trigger.id}"] gateway error: ${describeDiscordGatewayError(err)}`);
    });
    gateway.onMessage((message) => {
      // Runaway-loop guard: a bot that replies in a channel it also watches must never trigger
      // itself. Only the bot's OWN messages are excluded — a different bot's messages are an
      // opt-in case (an author allowlist), not implemented in this v1.
      if (this.botUserId && message.authorId === this.botUserId) return;
      if (!allowedChannels.has(message.channelId)) return;
      this.opts.onMessage(trigger, message);
    });

    await gateway.login(this.opts.botToken);
  }

  async stop(): Promise<void> {
    await this.gateway?.destroy();
    this.gateway = undefined;
  }

  /** Bounded post-connect REST scan from each allowlisted channel's stored cursor — protects
   *  against a gateway drop, server restart, or deploy silently dropping every message sent in
   *  that window (dedupe only protects against seeing a message *twice*; nothing else protects
   *  against never seeing it at all). Skipped entirely for a channel with no cursor yet — a
   *  brand-new trigger starts at "now", not a full backlog replay. */
  private async recoverMissedMessages(trigger: TriggerRecord, allowedChannels: Set<string>): Promise<void> {
    const windowMs = (this.opts.recoveryWindowSeconds ?? 900) * 1000;
    const limit = this.opts.recoveryLimit ?? 50;
    const cutoffMs = Date.now() - windowMs;

    for (const channelId of allowedChannels) {
      const cursor = getTriggerCursor(this.opts.db, trigger.id, channelId);
      if (!cursor) continue;

      let messages;
      try {
        messages = await this.opts.restClient.readMessages(channelId, { after: cursor, limit });
      } catch (err) {
        console.error(`[discord-trigger "${trigger.id}"] recovery scan failed for channel ${channelId}: ${(err as Error).message}`);
        continue;
      }

      // Discord returns newest-first; replay oldest-first so processing order matches how these
      // would have arrived live.
      for (const m of [...messages].reverse()) {
        if (snowflakeTimestampMs(m.id) < cutoffMs) continue;
        if (this.botUserId && m.author.id === this.botUserId) continue;
        this.opts.onMessage(trigger, {
          id: m.id,
          channelId,
          authorId: m.author.id,
          authorIsBot: m.author.bot ?? false,
          content: m.content,
        });
      }
    }
  }
}

const DISCORD_EPOCH_MS = 1420070400000;

/** Discord message ids are Snowflakes — the top 42 bits are a millisecond timestamp offset from
 *  the Discord epoch, letting the recovery window be enforced without an extra API call. */
function snowflakeTimestampMs(id: string): number {
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS;
}
