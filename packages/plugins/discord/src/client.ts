import { retryAfterMsFromHeader } from "@flowlathe/providers";

export class DiscordError extends Error {}

const API_BASE = "https://discord.com/api/v10";
/** Discord's hard per-message limit is 2000 characters; chunk at 1900 for headroom (hermes-agent's
 *  figure). */
const CHUNK_SIZE = 1900;
/** From a logged incident: one degenerate turn posted 60,698 characters as 31 back-to-back
 *  messages. A local model looping on a prompt reproduces this exactly (see CLAUDE.md's own
 *  interpreter-concurrency-bug note for a similar self-repeating-output failure). */
const MAX_SPLIT_MESSAGES = 8;
const MAX_RETRIES = 3;
const DEFAULT_RETRY_MS = 1000;

export interface AllowedMentionsConfig {
  everyone?: boolean;
  roles?: boolean;
  /** Defaults to true — an ordinary @mention of a specific user is not the incident-prone case. */
  users?: boolean;
  /** Defaults to true — replying to someone should still ping them by default. */
  repliedUser?: boolean;
}

export interface DiscordAllowedMentions {
  parse: string[];
  replied_user: boolean;
}

/** Denies @everyone/@here and role pings by default while leaving user and reply pings on —
 *  hermes-agent's `_build_allowed_mentions()` shape. Built once (see `DiscordClient`'s
 *  constructor) and included in every send, so no call site can forget it — a per-call parameter
 *  is one missed call site away from a model that just read a hostile web page pinging the whole
 *  server. */
export function buildAllowedMentions(cfg: AllowedMentionsConfig = {}): DiscordAllowedMentions {
  const parse: string[] = [];
  if (cfg.everyone) parse.push("everyone");
  if (cfg.roles) parse.push("roles");
  if (cfg.users ?? true) parse.push("users");
  return { parse, replied_user: cfg.repliedUser ?? true };
}

/** Splits an over-long message into <=1900-char chunks, capped at `MAX_SPLIT_MESSAGES` with the
 *  final chunk replaced by a truncation notice. */
export function chunkMessageContent(content: string): string[] {
  if (content.length <= CHUNK_SIZE) return [content];
  const chunks: string[] = [];
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    chunks.push(content.slice(i, i + CHUNK_SIZE));
  }
  if (chunks.length > MAX_SPLIT_MESSAGES) {
    const kept = chunks.slice(0, MAX_SPLIT_MESSAGES - 1);
    kept.push(`[message truncated: ${content.length} total characters, ${chunks.length - kept.length} more chunk(s) omitted]`);
    return kept;
  }
  return chunks;
}

export interface DiscordMessageAuthor {
  id: string;
  username: string;
  bot?: boolean;
}

export interface DiscordMessage {
  id: string;
  author: DiscordMessageAuthor;
  content: string;
  timestamp: string;
}

export interface DiscordClientOptions {
  botToken: string;
  /** Overridable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  allowedMentions?: AllowedMentionsConfig;
}

/** Hand-rolled REST client over `fetch` — no `discord.js` dependency here (that only becomes
 *  necessary for the Phase E gateway). Bot-token auth is a static secret, which is what makes
 *  this simpler than Spotify's OAuth dance. */
export class DiscordClient {
  private readonly botToken: string;
  private readonly fetchImpl: typeof fetch;
  readonly allowedMentions: DiscordAllowedMentions;

  constructor(opts: DiscordClientOptions) {
    this.botToken = opts.botToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.allowedMentions = buildAllowedMentions(opts.allowedMentions);
  }

  /** Honors a 429's `Retry-After` (header or, if absent, the JSON body's `retry_after` seconds —
   *  Discord sends both, but only the body is guaranteed on every rate-limited route) with a
   *  bounded retry, per-route buckets aside — see `@flowlathe/providers`'s `retryAfterMsFromHeader`. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${API_BASE}${path}`, {
          method,
          headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (err) {
        throw new DiscordError(`could not reach Discord: ${(err as Error).message}`);
      }

      if (res.status === 429 && attempt < MAX_RETRIES) {
        const text = await res.text();
        let retryMs = retryAfterMsFromHeader(res.headers.get("Retry-After"));
        if (retryMs === undefined) {
          try {
            const parsed = JSON.parse(text) as { retry_after?: number };
            if (typeof parsed.retry_after === "number") retryMs = parsed.retry_after * 1000;
          } catch {
            // fall through to the default backoff
          }
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs ?? DEFAULT_RETRY_MS));
        continue;
      }

      const text = await res.text();
      if (!res.ok) {
        throw new DiscordError(`Discord API ${method} ${path} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
      }
      if (text.trim() === "") return undefined as T;
      return JSON.parse(text) as T;
    }
  }

  async sendMessage(channelId: string, content: string, replyToMessageId?: string): Promise<{ messageIds: string[] }> {
    const chunks = chunkMessageContent(content);
    const messageIds: string[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = { content: chunks[i], allowed_mentions: this.allowedMentions };
      if (replyToMessageId && i === 0) body["message_reference"] = { message_id: replyToMessageId };
      const created = await this.request<{ id: string }>("POST", `/channels/${channelId}/messages`, body);
      messageIds.push(created.id);
    }
    return { messageIds };
  }

  /** `after` (rather than `before`) is what Phase E's post-reconnect recovery scan needs — Discord's
   *  own API supports both on the same endpoint. The `discord_read_messages` tool only ever passes
   *  `before` (reading recent history backward); recovery passes `after` (reading forward from a
   *  cursor). Passing both is nonsensical and left to the caller to avoid. */
  async readMessages(channelId: string, opts: { limit?: number; before?: string; after?: string } = {}): Promise<DiscordMessage[]> {
    const params = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, opts.limit ?? 20))) });
    if (opts.before) params.set("before", opts.before);
    if (opts.after) params.set("after", opts.after);
    return this.request<DiscordMessage[]>("GET", `/channels/${channelId}/messages?${params.toString()}`);
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.request<void>("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
  }
}
