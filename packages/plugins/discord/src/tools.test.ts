import { describe, expect, it } from "vitest";
import { DiscordClient } from "./client.js";
import { createDiscordToolset, type DiscordToolsetOptions } from "./tools.js";

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (input: string | URL) => handler(new URL(String(input)))) as typeof fetch;
}

function toolByName(regs: ReturnType<typeof createDiscordToolset>, name: string) {
  const reg = regs.find((r) => r.spec.name === name);
  if (!reg) throw new Error(`no tool named ${name}`);
  return reg;
}

describe("discord_send_message tool", () => {
  it("refuses a channel not on the allowlist", async () => {
    const client = new DiscordClient({ botToken: "t" });
    const opts: DiscordToolsetOptions = { allowedChannelIds: new Set(["c1"]) };
    const tool = toolByName(createDiscordToolset(client, opts), "discord_send_message");
    const raw = await tool.handler({ channelId: "c2", content: "hi" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/not in DISCORD_ALLOWED_CHANNELS/);
  });

  it("sends on an allowed channel and returns the created message ids", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ id: "m1" }), { status: 200 }));
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    const opts: DiscordToolsetOptions = { allowedChannelIds: new Set(["c1"]) };
    const tool = toolByName(createDiscordToolset(client, opts), "discord_send_message");
    const raw = await tool.handler({ channelId: "c1", content: "hi" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; data: { messageIds: string[] } };
    expect(parsed).toEqual({ ok: true, data: { messageIds: ["m1"] } });
  });

  it("fails cleanly with a missing content argument", async () => {
    const client = new DiscordClient({ botToken: "t" });
    const opts: DiscordToolsetOptions = { allowedChannelIds: new Set(["c1"]) };
    const tool = toolByName(createDiscordToolset(client, opts), "discord_send_message");
    const raw = await tool.handler({ channelId: "c1" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/missing required argument "content"/);
  });
});

describe("discord_read_messages tool", () => {
  it("sanitizes message content/author before returning", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify([{ id: "m1", author: { id: "u1", username: "alice" }, content: "hello world", timestamp: "t" }]),
          { status: 200 },
        ),
    );
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    const opts: DiscordToolsetOptions = { allowedChannelIds: new Set(["c1"]) };
    const tool = toolByName(createDiscordToolset(client, opts), "discord_read_messages");
    const raw = await tool.handler({ channelId: "c1" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; data: { id: string; author: string; content: string }[] };
    expect(parsed).toEqual({ ok: true, data: [{ id: "m1", author: "alice", content: "hello world", timestamp: "t" }] });
  });

  it("strips hidden characters from message content/author — the mutation the FIX doc warns about", async () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify([
            { id: "m1", author: { id: "u1", username: `alice${zeroWidthSpace}` }, content: `hello${zeroWidthSpace}world`, timestamp: "t" },
          ]),
          { status: 200 },
        ),
    );
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    const opts: DiscordToolsetOptions = { allowedChannelIds: new Set(["c1"]) };
    const tool = toolByName(createDiscordToolset(client, opts), "discord_read_messages");
    const raw = await tool.handler({ channelId: "c1" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; data: { id: string; author: string; content: string }[] };
    expect(parsed).toEqual({ ok: true, data: [{ id: "m1", author: "alice", content: "helloworld", timestamp: "t" }] });
  });
});

describe("discord_react tool", () => {
  it("reports a network failure through the tool envelope rather than throwing", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    const opts: DiscordToolsetOptions = { allowedChannelIds: new Set(["c1"]) };
    const tool = toolByName(createDiscordToolset(client, opts), "discord_react");
    const raw = await tool.handler({ channelId: "c1", messageId: "m1", emoji: "👍" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/could not reach Discord/);
  });
});

describe("unavailableReason", () => {
  it("reports unavailable when no channel is allowlisted", () => {
    const client = new DiscordClient({ botToken: "t" });
    const [reg] = createDiscordToolset(client, { allowedChannelIds: new Set() });
    expect(reg!.unavailableReason?.()).toMatch(/no allowed channels configured/);
  });

  it("is undefined once at least one channel is allowlisted", () => {
    const client = new DiscordClient({ botToken: "t" });
    const [reg] = createDiscordToolset(client, { allowedChannelIds: new Set(["c1"]) });
    expect(reg!.unavailableReason?.()).toBeUndefined();
  });
});
