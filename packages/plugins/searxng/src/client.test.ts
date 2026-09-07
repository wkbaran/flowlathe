import { describe, expect, it } from "vitest";
import { SearxngClient } from "./client.js";

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (input: string | URL) => handler(new URL(String(input)))) as typeof fetch;
}

describe("SearxngClient.search", () => {
  it("hits /search with format=json&pageno=1 and the query", async () => {
    let seen: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      seen = url;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    await client.search("hello world");
    expect(seen?.pathname).toBe("/search");
    expect(seen?.searchParams.get("q")).toBe("hello world");
    expect(seen?.searchParams.get("format")).toBe("json");
    expect(seen?.searchParams.get("pageno")).toBe("1");
  });

  it("sorts results by score descending", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [
              { title: "low", url: "http://a", content: "a", score: 0.2, engine: "google" },
              { title: "high", url: "http://b", content: "b", score: 0.9, engine: "bing" },
              { title: "mid", url: "http://c", content: "c", score: 0.5, engine: "duckduckgo" },
            ],
          }),
          { status: 200 },
        ),
    );
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    const results = await client.search("q");
    expect(results.map((r) => r.title)).toEqual(["high", "mid", "low"]);
  });

  it("caps the result count at SEARCH_LIMIT_CAP (20) even if a caller asks for more", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      title: `r${i}`,
      url: `http://x/${i}`,
      content: "c",
      score: i,
      engine: "e",
    }));
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({ results: many }), { status: 200 }));
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    const results = await client.search("q", { limit: 1000 });
    expect(results.length).toBe(20);
    expect(results[0]!.title).toBe("r29");
  });

  it("strips a trailing slash from baseUrl", async () => {
    let seen: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      seen = url;
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    });
    const client = new SearxngClient({ baseUrl: "http://localhost:8080/", fetchImpl });
    await client.search("q");
    expect(`${seen?.origin ?? ""}${seen?.pathname ?? ""}`).toBe("http://localhost:8080/search");
  });

  it("throws a reachability error naming the instance when the fetch itself fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    await expect(client.search("q")).rejects.toThrow(/could not reach http:\/\/localhost:8080/);
  });
});

describe("SearxngClient.isReachable", () => {
  it("returns true on a successful /config response", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    expect(await client.isReachable()).toBe(true);
  });

  it("returns false when the request fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("network error");
    }) as unknown as typeof fetch;
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    expect(await client.isReachable()).toBe(false);
  });
});
