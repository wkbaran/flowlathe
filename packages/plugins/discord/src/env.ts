import type { ToolRegistration } from "@flowlathe/core";
import { DiscordClient } from "./client.js";
import { createDiscordToolset } from "./tools.js";

/** `undefined` when `DISCORD_BOT_TOKEN` isn't set — the secure default: unset env var, zero tool
 *  registrations. */
export function discordClientFromEnv(env: NodeJS.ProcessEnv = process.env): DiscordClient | undefined {
  const botToken = env["DISCORD_BOT_TOKEN"];
  if (!botToken) return undefined;
  return new DiscordClient({
    botToken,
    allowedMentions: {
      everyone: env["DISCORD_ALLOW_MENTION_EVERYONE"] === "1",
      roles: env["DISCORD_ALLOW_MENTION_ROLES"] === "1",
      users: env["DISCORD_ALLOW_MENTION_USERS"] !== "0",
      repliedUser: env["DISCORD_ALLOW_MENTION_REPLIED_USER"] !== "0",
    },
  });
}

/** `DISCORD_ALLOWED_CHANNELS` unset or empty ⇒ an empty set, meaning no channel is allowed —
 *  matches `MCP_ALLOWED_COMMANDS`'s secure default. */
export function discordAllowedChannelsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const csv = env["DISCORD_ALLOWED_CHANNELS"];
  if (!csv) return new Set();
  return new Set(
    csv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** No `standalone` field (unlike SearXNG/Firecrawl) — Discord is explicitly server-only per
 *  PLAN-INTEGRATIONS.md's Locked Decisions table; a compiled script using this toolset refuses
 *  to run, same as Spotify/MCP. */
export function discordToolsetFromEnv(env: NodeJS.ProcessEnv = process.env): ToolRegistration[] {
  const client = discordClientFromEnv(env);
  if (!client) return [];
  return createDiscordToolset(client, { allowedChannelIds: discordAllowedChannelsFromEnv(env) });
}
