import type { ToolInvokeMeta, ToolRegistration, ToolSpec } from "@flowlathe/core";
import { clampLimit, guarded, requireString, sanitizeUntrustedText, toolFail, toolOk } from "@flowlathe/plugin-common";
import { DiscordClient, type DiscordMessage } from "./client.js";

export interface DiscordToolsetOptions {
  /** `DISCORD_ALLOWED_CHANNELS` (comma-separated ids), parsed. Empty means no channel is
   *  allowed — the same secure default as `MCP_ALLOWED_COMMANDS`. Every tool checks the channel
   *  id it's given against this before doing anything. */
  allowedChannelIds: Set<string>;
}

function channelAllowlistError(channelId: string, allowed: Set<string>): string | undefined {
  return allowed.has(channelId) ? undefined : `channel "${channelId}" is not in DISCORD_ALLOWED_CHANNELS`;
}

export const DISCORD_SEND_MESSAGE_TOOL: ToolSpec = {
  name: "discord_send_message",
  description: "Send a message to a Discord channel. Long messages are split into multiple chunks.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Discord channel id" },
      content: { type: "string", description: "message text" },
      replyToMessageId: { type: "string", description: "optional message id to reply to" },
    },
    required: ["channelId", "content"],
  },
};

export const DISCORD_READ_MESSAGES_TOOL: ToolSpec = {
  name: "discord_read_messages",
  description: "Read recent messages from a Discord channel.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Discord channel id" },
      limit: { type: "number", description: "max messages, 1-100 (default 20)" },
      before: { type: "string", description: "only return messages before this message id" },
    },
    required: ["channelId"],
  },
};

export const DISCORD_REACT_TOOL: ToolSpec = {
  name: "discord_react",
  description: "Add an emoji reaction to a Discord message.",
  parameters: {
    type: "object",
    properties: {
      channelId: { type: "string", description: "Discord channel id" },
      messageId: { type: "string", description: "message id to react to" },
      emoji: { type: "string", description: 'unicode emoji, or "name:id" for a custom emoji' },
    },
    required: ["channelId", "messageId", "emoji"],
  },
};

function summarizeMessage(m: DiscordMessage): Record<string, unknown> {
  return {
    id: m.id,
    author: sanitizeUntrustedText(m.author.username, 100, "discord message"),
    content: sanitizeUntrustedText(m.content, 2000, "discord message"),
    timestamp: m.timestamp,
  };
}

function sendMessageTool(client: DiscordClient, opts: DiscordToolsetOptions): ToolRegistration["handler"] {
  return async (args, _meta: ToolInvokeMeta) => {
    let channelId: string, content: string;
    try {
      channelId = requireString(args, "channelId");
      content = requireString(args, "content");
    } catch (err) {
      return toolFail((err as Error).message);
    }
    const allowlistError = channelAllowlistError(channelId, opts.allowedChannelIds);
    if (allowlistError) return toolFail(allowlistError);
    const replyToMessageId = typeof args["replyToMessageId"] === "string" ? args["replyToMessageId"] : undefined;
    const result = await guarded("discord", "send_message", () => client.sendMessage(channelId, content, replyToMessageId));
    return result.ok ? toolOk(result.data) : toolFail(result.error);
  };
}

function readMessagesTool(client: DiscordClient, opts: DiscordToolsetOptions): ToolRegistration["handler"] {
  return async (args) => {
    let channelId: string;
    try {
      channelId = requireString(args, "channelId");
    } catch (err) {
      return toolFail((err as Error).message);
    }
    const allowlistError = channelAllowlistError(channelId, opts.allowedChannelIds);
    if (allowlistError) return toolFail(allowlistError);
    const before = typeof args["before"] === "string" ? args["before"] : undefined;
    const result = await guarded("discord", "read_messages", () =>
      client.readMessages(channelId, clampLimit(args["limit"], 20, 100), before),
    );
    return result.ok ? toolOk(result.data.map(summarizeMessage)) : toolFail(result.error);
  };
}

function reactTool(client: DiscordClient, opts: DiscordToolsetOptions): ToolRegistration["handler"] {
  return async (args) => {
    let channelId: string, messageId: string, emoji: string;
    try {
      channelId = requireString(args, "channelId");
      messageId = requireString(args, "messageId");
      emoji = requireString(args, "emoji");
    } catch (err) {
      return toolFail((err as Error).message);
    }
    const allowlistError = channelAllowlistError(channelId, opts.allowedChannelIds);
    if (allowlistError) return toolFail(allowlistError);
    const result = await guarded("discord", "react", () => client.react(channelId, messageId, emoji));
    return result.ok ? toolOk({ ok: true }) : toolFail(result.error);
  };
}

/** Deliberately no `unavailableReason` network probe (Discord has no cheap health endpoint worth
 *  hitting on every dependency check) — instead reports itself unavailable whenever there's no
 *  allowed channel at all, since every tool call would fail the allowlist check regardless. */
export function createDiscordToolset(client: DiscordClient, opts: DiscordToolsetOptions): ToolRegistration[] {
  const unavailableReason = () =>
    opts.allowedChannelIds.size === 0 ? "Discord has no allowed channels configured (set DISCORD_ALLOWED_CHANNELS)" : undefined;
  return [
    { toolset: "discord", spec: DISCORD_SEND_MESSAGE_TOOL, handler: sendMessageTool(client, opts), unavailableReason },
    { toolset: "discord", spec: DISCORD_READ_MESSAGES_TOOL, handler: readMessagesTool(client, opts), unavailableReason },
    { toolset: "discord", spec: DISCORD_REACT_TOOL, handler: reactTool(client, opts), unavailableReason },
  ];
}
