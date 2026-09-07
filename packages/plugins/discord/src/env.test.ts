import { describe, expect, it } from "vitest";
import { discordAllowedChannelsFromEnv, discordClientFromEnv, discordToolsetFromEnv } from "./env.js";

describe("discordClientFromEnv", () => {
  it("returns undefined when DISCORD_BOT_TOKEN is unset", () => {
    expect(discordClientFromEnv({})).toBeUndefined();
  });

  it("builds a client once configured", () => {
    expect(discordClientFromEnv({ DISCORD_BOT_TOKEN: "t" })).toBeInstanceOf(Object);
  });
});

describe("discordAllowedChannelsFromEnv", () => {
  it("is empty when unset (secure default)", () => {
    expect(discordAllowedChannelsFromEnv({})).toEqual(new Set());
  });

  it("parses a comma-separated list", () => {
    expect(discordAllowedChannelsFromEnv({ DISCORD_ALLOWED_CHANNELS: "c1, c2,c3" })).toEqual(new Set(["c1", "c2", "c3"]));
  });
});

describe("discordToolsetFromEnv", () => {
  it("registers zero tools when unconfigured", () => {
    expect(discordToolsetFromEnv({})).toEqual([]);
  });

  it("registers all three tools once a bot token is set", () => {
    const regs = discordToolsetFromEnv({ DISCORD_BOT_TOKEN: "t", DISCORD_ALLOWED_CHANNELS: "c1" });
    expect(regs.map((r) => r.spec.name).sort()).toEqual(["discord_react", "discord_read_messages", "discord_send_message"]);
  });
});
