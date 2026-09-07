import { describe, expect, it } from "vitest";
import { SearxngClient } from "./client.js";
import { createSearxngToolset } from "./tools.js";

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (input: string | URL) => handler(new URL(String(input)))) as typeof fetch;
}

describe("searxng_search tool", () => {
  it("returns a compact, trimmed JSON array on success", async () => {
    const fetchImpl = fakeFetch((url) =>
      url.pathname === "/config"
        ? new Response(JSON.stringify({}), { status: 200 })
        : new Response(
            JSON.stringify({
              results: [{ title: "Result <b>1</b>", url: "http://a", content: "snippet text", score: 1, engine: "google" }],
            }),
            { status: 200 },
          ),
    );
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    const [reg] = createSearxngToolset(client);
    const raw = await reg!.handler({ query: "hello" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; data: { title: string; url: string; snippet: string; engine: string }[] };
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual([{ title: "Result <b>1</b>", url: "http://a", snippet: "snippet text", engine: "google" }]);
  });

  it("strips hidden characters from result title/content — the mutation the FIX doc warns about", async () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const fetchImpl = fakeFetch((url) =>
      url.pathname === "/config"
        ? new Response(JSON.stringify({}), { status: 200 })
        : new Response(
            JSON.stringify({
              results: [
                {
                  title: `Evil${zeroWidthSpace}Title`,
                  url: "http://a",
                  content: `hidden${zeroWidthSpace}snippet`,
                  score: 1,
                  engine: "google",
                },
              ],
            }),
            { status: 200 },
          ),
    );
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    const [reg] = createSearxngToolset(client);
    const raw = await reg!.handler({ query: "hello" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; data: { title: string; snippet: string }[] };
    expect(parsed.data).toEqual([{ title: "EvilTitle", url: "http://a", snippet: "hiddensnippet", engine: "google" }]);
  });

  it("fails cleanly with a missing query argument", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    const [reg] = createSearxngToolset(client);
    const raw = await reg!.handler({}, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/missing required argument "query"/);
  });

  it("reports a network failure through the tool envelope rather than throwing", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    const [reg] = createSearxngToolset(client);
    const raw = await reg!.handler({ query: "hello" }, { activationKey: "n1" });
    const parsed = JSON.parse(raw) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/could not reach http:\/\/localhost:8080/);
  });

  it("unavailableReason reports unreachable once the cached probe fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    const [reg] = createSearxngToolset(client);
    // The probe kicked off at registration is async — give it a tick to resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(reg!.unavailableReason?.()).toBe("SearXNG at http://localhost:8080 is not reachable");
  });

  it("unavailableReason is undefined once the cached probe succeeds", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const client = new SearxngClient({ baseUrl: "http://localhost:8080", fetchImpl });
    const [reg] = createSearxngToolset(client);
    await new Promise((r) => setTimeout(r, 0));
    expect(reg!.unavailableReason?.()).toBeUndefined();
  });
});
