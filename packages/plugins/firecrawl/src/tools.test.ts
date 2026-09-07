import { describe, expect, it } from "vitest";
import { FirecrawlClient } from "./client.js";
import { createFirecrawlToolset } from "./tools.js";

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (input: string | URL) => handler(new URL(String(input)))) as typeof fetch;
}

function toolByName(regs: ReturnType<typeof createFirecrawlToolset>, name: string) {
  const reg = regs.find((r) => r.spec.name === name);
  if (!reg) throw new Error(`no tool named ${name}`);
  return reg;
}

describe("firecrawl_scrape tool", () => {
  it("returns ok:true with url/title/content on success", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.pathname === "/v2/map"
        ? new Response(JSON.stringify({ links: [] }), { status: 200 })
        : new Response(JSON.stringify({ data: { markdown: "hi", metadata: { title: "T", sourceURL: "https://example.com/" } } }), {
            status: 200,
          }),
    );
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl });
    const tool = toolByName(createFirecrawlToolset(client), "firecrawl_scrape");
    const raw = await tool.handler({ url: "https://example.com/" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; data: { url: string; title: string; content: string } };
    expect(parsed).toEqual({ ok: true, data: { url: "https://example.com/", title: "T", content: "hi" } });
  });

  it("fails cleanly with a missing url argument", async () => {
    const client = new FirecrawlClient({ apiKey: "key" });
    const tool = toolByName(createFirecrawlToolset(client), "firecrawl_scrape");
    const raw = await tool.handler({}, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/missing required argument "url"/);
  });

  it("reports a blocked URL through the tool envelope", async () => {
    const client = new FirecrawlClient({ apiKey: "key" });
    const tool = toolByName(createFirecrawlToolset(client), "firecrawl_scrape");
    const raw = await tool.handler({ url: "http://127.0.0.1/" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/private or internal/);
  });
});

describe("firecrawl_map tool", () => {
  it("returns discovered urls", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ links: ["https://example.com/a"] }), { status: 200 }));
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl });
    const tool = toolByName(createFirecrawlToolset(client), "firecrawl_map");
    const raw = await tool.handler({ url: "https://example.com/" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; data: string[] };
    expect(parsed).toEqual({ ok: true, data: ["https://example.com/a"] });
  });
});

describe("firecrawl_crawl tool", () => {
  it("returns an array of per-page outcomes", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.pathname === "/v2/crawl"
        ? new Response(JSON.stringify({ id: "job" }), { status: 200 })
        : new Response(
            JSON.stringify({ status: "completed", data: [{ markdown: "x", metadata: { sourceURL: "https://example.com/a" } }] }),
            { status: 200 },
          ),
    );
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl, crawlPollIntervalMs: 1 });
    const tool = toolByName(createFirecrawlToolset(client), "firecrawl_crawl");
    const raw = await tool.handler({ url: "https://example.com/" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; data: { url: string; content: string }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual([{ url: "https://example.com/a", title: undefined, content: "x" }]);
  });
});

describe("unavailableReason", () => {
  it("reports unavailable once the cached auth probe fails", async () => {
    const fetchImpl = fakeFetch(() => new Response("unauthorized", { status: 401 }));
    const client = new FirecrawlClient({ apiKey: "bad-key", fetchImpl });
    const [reg] = createFirecrawlToolset(client);
    await new Promise((r) => setTimeout(r, 0));
    expect(reg!.unavailableReason?.()).toMatch(/not authorized or reachable/);
  });

  it("is undefined once the cached auth probe succeeds", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ links: [] }), { status: 200 }));
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl });
    const [reg] = createFirecrawlToolset(client);
    await new Promise((r) => setTimeout(r, 0));
    expect(reg!.unavailableReason?.()).toBeUndefined();
  });
});
