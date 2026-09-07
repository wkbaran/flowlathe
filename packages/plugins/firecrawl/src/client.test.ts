import { describe, expect, it } from "vitest";
import { FirecrawlClient } from "./client.js";

function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => handler(new URL(String(input)), init)) as typeof fetch;
}

describe("FirecrawlClient.scrapeOne", () => {
  it("returns trimmed content on success", async () => {
    const fetchImpl = fakeFetch(() =>
      new Response(
        JSON.stringify({ data: { markdown: "# Hello", metadata: { title: "Hi", sourceURL: "https://example.com/" } } }),
        { status: 200 },
      ),
    );
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl });
    const result = await client.scrapeOne("https://example.com/");
    expect(result).toEqual({ url: "https://example.com/", title: "Hi", content: "# Hello" });
  });

  it("sends the API key as a bearer token", async () => {
    let seenAuth: string | null = null;
    const fetchImpl = fakeFetch((_url, init) => {
      seenAuth = (init?.headers as Record<string, string>)["Authorization"] ?? null;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    });
    const client = new FirecrawlClient({ apiKey: "secret-key", fetchImpl });
    await client.scrapeOne("https://example.com/");
    expect(seenAuth).toBe("Bearer secret-key");
  });

  it("truncates content over maxChars with a marker", async () => {
    const long = "x".repeat(100);
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ data: { markdown: long } }), { status: 200 }));
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl, maxChars: 10 });
    const result = await client.scrapeOne("https://example.com/");
    expect(result.error).toBeUndefined();
    expect(result.content).toBe(`${"x".repeat(10)}\n[truncated 10 of 100 chars]`);
  });

  it("strips hidden characters from markdown while keeping the truncation marker intact", async () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const tagChar = String.fromCodePoint(0xe0001);
    const long = `${"x".repeat(5)}${zeroWidthSpace}${tagChar}${"x".repeat(95)}`;
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ data: { markdown: long } }), { status: 200 }));
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl, maxChars: 10 });
    const result = await client.scrapeOne("https://example.com/");
    expect(result.error).toBeUndefined();
    // hidden chars stripped before truncation, so the cleaned text (100 chars) still hits the cap
    expect(result.content).toBe(`${"x".repeat(10)}\n[truncated 10 of 100 chars]`);
  });

  it("sanitizes the page title", async () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ data: { markdown: "hi", metadata: { title: `Evil${zeroWidthSpace}Title`, sourceURL: "https://example.com/" } } }),
          { status: 200 },
        ),
    );
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl });
    const result = await client.scrapeOne("https://example.com/");
    expect(result.title).toBe("EvilTitle");
  });

  it("returns a per-URL error rather than throwing on a blocked (private) URL", async () => {
    const client = new FirecrawlClient({ apiKey: "key" });
    const result = await client.scrapeOne("http://127.0.0.1/secret");
    expect(result.error).toMatch(/private or internal/);
    expect(result.content).toBeUndefined();
  });

  it("re-validates the post-redirect final URL and blocks it if unsafe", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ data: { markdown: "leaked", metadata: { sourceURL: "http://169.254.169.254/latest/meta-data/" } } }),
          { status: 200 },
        ),
    );
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl });
    const result = await client.scrapeOne("https://public-redirector.example/");
    expect(result.error).toMatch(/metadata endpoint/);
  });

  it("returns a per-URL error rather than throwing on a network failure", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl });
    const result = await client.scrapeOne("https://example.com/");
    expect(result.error).toMatch(/could not reach/);
  });

  it("returns a per-URL error on a non-2xx response", async () => {
    const fetchImpl = fakeFetch(() => new Response("not found", { status: 404 }));
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl });
    const result = await client.scrapeOne("https://example.com/missing");
    expect(result.error).toMatch(/HTTP 404/);
  });
});

describe("FirecrawlClient.crawl", () => {
  it("submits, polls until completed, and returns per-page outcomes", async () => {
    let pollCount = 0;
    const fetchImpl = fakeFetch((url) => {
      if (url.pathname === "/v2/crawl") {
        return new Response(JSON.stringify({ id: "job-1" }), { status: 200 });
      }
      pollCount++;
      if (pollCount < 2) {
        return new Response(JSON.stringify({ status: "scraping" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          data: [{ markdown: "page one", metadata: { sourceURL: "https://example.com/a" } }],
        }),
        { status: 200 },
      );
    });
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl, crawlPollIntervalMs: 1 });
    const results = await client.crawl("https://example.com/");
    expect(results).toEqual([{ url: "https://example.com/a", title: undefined, content: "page one" }]);
  });

  it("reports a timeout without hanging forever", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.pathname === "/v2/crawl"
        ? new Response(JSON.stringify({ id: "job-1" }), { status: 200 })
        : new Response(JSON.stringify({ status: "scraping" }), { status: 200 }),
    );
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl, crawlTimeoutMs: 5, crawlPollIntervalMs: 1 });
    const results = await client.crawl("https://example.com/");
    expect(results).toHaveLength(1);
    expect(results[0]!.error).toMatch(/timed out/);
  });

  it("reports a failed crawl status without throwing", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.pathname === "/v2/crawl"
        ? new Response(JSON.stringify({ id: "job-1" }), { status: 200 })
        : new Response(JSON.stringify({ status: "failed" }), { status: 200 }),
    );
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl, crawlPollIntervalMs: 1 });
    const results = await client.crawl("https://example.com/");
    expect(results).toEqual([{ url: "https://example.com/", error: "Firecrawl crawl failed" }]);
  });

  it("keeps one bad page's error isolated rather than failing the whole crawl", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.pathname === "/v2/crawl"
        ? new Response(JSON.stringify({ id: "job-1" }), { status: 200 })
        : new Response(
            JSON.stringify({
              status: "completed",
              data: [
                { markdown: "good", metadata: { sourceURL: "https://example.com/good" } },
                { markdown: "leaked", metadata: { sourceURL: "http://127.0.0.1/admin" } },
              ],
            }),
            { status: 200 },
          ),
    );
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl, crawlPollIntervalMs: 1 });
    const results = await client.crawl("https://example.com/");
    expect(results[0]).toEqual({ url: "https://example.com/good", title: undefined, content: "good" });
    expect(results[1]!.error).toMatch(/private or internal/);
  });
});

describe("FirecrawlClient.map", () => {
  it("returns discovered urls", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ links: ["https://example.com/a", "https://example.com/b"] }), { status: 200 }));
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl });
    const result = await client.map("https://example.com/");
    expect(result).toEqual({ urls: ["https://example.com/a", "https://example.com/b"] });
  });

  it("returns an error rather than throwing for a blocked URL", async () => {
    const client = new FirecrawlClient({ apiKey: "key" });
    const result = await client.map("http://169.254.169.254/");
    expect("error" in result && result.error).toMatch(/metadata endpoint/);
  });
});

describe("FirecrawlClient.isAuthorized", () => {
  it("returns true on a successful probe", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ links: [] }), { status: 200 }));
    const client = new FirecrawlClient({ apiKey: "key", fetchImpl });
    expect(await client.isAuthorized()).toBe(true);
  });

  it("returns false on a 401", async () => {
    const fetchImpl = fakeFetch(() => new Response("unauthorized", { status: 401 }));
    const client = new FirecrawlClient({ apiKey: "bad-key", fetchImpl });
    expect(await client.isAuthorized()).toBe(false);
  });
});
