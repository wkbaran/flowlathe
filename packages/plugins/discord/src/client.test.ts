import { describe, expect, it, vi } from "vitest";
import { buildAllowedMentions, chunkMessageContent, DiscordClient } from "./client.js";

function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => handler(new URL(String(input)), init)) as typeof fetch;
}

describe("buildAllowedMentions", () => {
  it("denies everyone/roles and allows users/replied_user by default", () => {
    expect(buildAllowedMentions()).toEqual({ parse: ["users"], replied_user: true });
  });

  it("respects explicit overrides", () => {
    expect(buildAllowedMentions({ everyone: true, roles: true, users: false, repliedUser: false })).toEqual({
      parse: ["everyone", "roles"],
      replied_user: false,
    });
  });
});

describe("chunkMessageContent", () => {
  it("returns a single chunk for a short message", () => {
    expect(chunkMessageContent("hello")).toEqual(["hello"]);
  });

  it("splits at 1900 characters", () => {
    const content = "a".repeat(2500);
    const chunks = chunkMessageContent(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBe(1900);
    expect(chunks[1]!.length).toBe(600);
  });

  it("caps at 8 chunks with a truncation notice replacing the rest", () => {
    const content = "a".repeat(1900 * 20);
    const chunks = chunkMessageContent(content);
    expect(chunks).toHaveLength(8);
    expect(chunks[7]).toMatch(/truncated/);
    expect(chunks.slice(0, 7).every((c) => c.length === 1900)).toBe(true);
  });
});

describe("DiscordClient", () => {
  it("sends the bot token as an Authorization header", async () => {
    let seenAuth: string | null = null;
    const fetchImpl = fakeFetch((_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)["Authorization"] ?? null;
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    });
    const client = new DiscordClient({ botToken: "secret-token", fetchImpl });
    await client.sendMessage("c1", "hi");
    expect(seenAuth).toBe("Bot secret-token");
  });

  it("includes allowed_mentions in every send", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    });
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    await client.sendMessage("c1", "hi");
    expect(seenBody?.["allowed_mentions"]).toEqual({ parse: ["users"], replied_user: true });
  });

  it("sends one message per chunk for an over-long message and returns all ids", async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(() => {
      calls++;
      return new Response(JSON.stringify({ id: `m${calls}` }), { status: 200 });
    });
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    const result = await client.sendMessage("c1", "a".repeat(1900 * 3));
    expect(calls).toBe(3);
    expect(result.messageIds).toEqual(["m1", "m2", "m3"]);
  });

  it("sets message_reference only on the first chunk when replying", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = fakeFetch((_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "m" }), { status: 200 });
    });
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    await client.sendMessage("c1", "a".repeat(1900 * 2), "original-id");
    expect(bodies[0]!["message_reference"]).toEqual({ message_id: "original-id" });
    expect(bodies[1]!["message_reference"]).toBeUndefined();
  });

  it("retries on 429 honoring the Retry-After header, then succeeds", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const fetchImpl = fakeFetch(() => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify({ message: "rate limited", retry_after: 0.01 }), {
          status: 429,
          headers: { "Retry-After": "0.01" },
        });
      }
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    });
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    const promise = client.sendMessage("c1", "hi");
    await vi.advanceTimersByTimeAsync(50);
    const result = await promise;
    expect(result.messageIds).toEqual(["m1"]);
    expect(attempt).toBe(2);
    vi.useRealTimers();
  });

  it("gives up after MAX_RETRIES consecutive 429s", async () => {
    vi.useFakeTimers();
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ retry_after: 0.001 }), { status: 429, headers: { "Retry-After": "0.001" } }),
    );
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    const promise = client.sendMessage("c1", "hi");
    const expectation = expect(promise).rejects.toThrow(/HTTP 429/);
    await vi.advanceTimersByTimeAsync(1000);
    await expectation;
    vi.useRealTimers();
  });

  it("readMessages clamps limit into [1,100] and reports failures without throwing raw fetch errors", async () => {
    let seenUrl: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify([]), { status: 200 });
    });
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    await client.readMessages("c1", 500);
    expect(seenUrl?.searchParams.get("limit")).toBe("100");
  });

  it("react PUTs to the reactions endpoint with an encoded emoji", async () => {
    let seenUrl: URL | undefined;
    let seenMethod: string | undefined;
    const fetchImpl = fakeFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method;
      return new Response(null, { status: 204 });
    });
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    await client.react("c1", "m1", "👍");
    expect(seenMethod).toBe("PUT");
    expect(seenUrl?.pathname).toContain("/channels/c1/messages/m1/reactions/");
  });

  it("throws a clear error when the fetch itself fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new DiscordClient({ botToken: "t", fetchImpl });
    await expect(client.sendMessage("c1", "hi")).rejects.toThrow(/could not reach Discord/);
  });
});
