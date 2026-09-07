import type { PluginManifest } from "@flowlathe/core";

export const DISCORD_MANIFEST: PluginManifest = {
  toolset: "discord",
  displayName: "Discord",
  description: "Send messages, read channel history, and react — outbound only (no inbound triggers yet).",
  env: [
    {
      name: "DISCORD_BOT_TOKEN",
      description: "Bot token from a Discord Developer Portal application",
      required: true,
      secret: true,
      docsUrl: "https://discord.com/developers/docs/topics/oauth2#bots",
    },
    {
      name: "DISCORD_ALLOWED_CHANNELS",
      description: "Comma-separated channel ids the bot may act in — unset means none (secure default)",
      required: false,
      secret: false,
    },
    {
      name: "DISCORD_ALLOW_MENTION_EVERYONE",
      description: '"1" to allow @everyone/@here in sent messages (default: denied)',
      required: false,
      secret: false,
    },
    {
      name: "DISCORD_ALLOW_MENTION_ROLES",
      description: '"1" to allow role pings in sent messages (default: denied)',
      required: false,
      secret: false,
    },
  ],
};
