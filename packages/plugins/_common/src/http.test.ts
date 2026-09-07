import { describe, expect, it } from "vitest";
import { guarded, httpGetJson, PluginHttpError, PluginNetworkError, requestJson } from "./http.js";

function fakeFetch(handler: (url: URL, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => handler(new URL(String(input)), init)) as typeof fetch;
}

describe("httpGetJson", () => {
  it("parses a JSON response and appends query params", async () => {
    let seen: URL | undefined;
    const fetchImpl = fakeFetch((url) => {
      seen = url;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const result = await httpGetJson<{ ok: boolean }>("test", "http://example.test/search", {
      params: { q: "hi", skip: undefined },
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(seen?.searchParams.get("q")).toBe("hi");
    expect(seen?.searchParams.has("skip")).toBe(false);
  });

  it("throws PluginNetworkError when fetch itself rejects, naming reachTarget", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      httpGetJson("test", "http://example.test/", { fetchImpl, reachTarget: "http://example.test" }),
    ).rejects.toThrow(PluginNetworkError);
    await expect(httpGetJson("test", "http://example.test/", { fetchImpl, reachTarget: "http://example.test" })).rejects.toThrow(
      /could not reach http:\/\/example\.test/,
    );
  });

  it("throws PluginHttpError with the response body on a non-2xx status", async () => {
    const fetchImpl = fakeFetch(() => new Response("bad request details", { status: 400 }));
    await expect(httpGetJson("test", "http://example.test/", { fetchImpl })).rejects.toMatchObject({
      status: 400,
      body: "bad request details",
    });
  });

  it("throws SyntaxError on unparseable JSON", async () => {
    const fetchImpl = fakeFetch(() => new Response("not json", { status: 200 }));
    await expect(httpGetJson("test", "http://example.test/", { fetchImpl })).rejects.toThrow(SyntaxError);
  });
});

describe("requestJson", () => {
  it("sends a JSON body with Content-Type for POST", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenInit = init;
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    });
    await requestJson("test", "http://example.test/", "POST", { body: { a: 1 }, fetchImpl });
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.body).toBe(JSON.stringify({ a: 1 }));
    expect((seenInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });
});

describe("guarded", () => {
  it("returns ok:true with the data on success", async () => {
    const result = await guarded("vendor", "search", async () => 42);
    expect(result).toEqual({ ok: true, data: 42 });
  });

  it("passes a PluginHttpError's own message + body through unprefixed", async () => {
    const result = await guarded("vendor", "search", async () => {
      throw new PluginHttpError("vendor search: HTTP 500", 500, "server exploded");
    });
    expect(result).toEqual({ ok: false, error: "vendor search: HTTP 500 - server exploded" });
  });

  it("passes a PluginNetworkError's own message through unprefixed", async () => {
    const result = await guarded("vendor", "search", async () => {
      throw new PluginNetworkError("vendor search: could not reach vendor.test");
    });
    expect(result).toEqual({ ok: false, error: "vendor search: could not reach vendor.test" });
  });

  it("classifies a generic error with a fallback message", async () => {
    const result = await guarded("vendor", "search", async () => {
      throw new Error("something else");
    });
    expect(result).toEqual({ ok: false, error: "vendor search failed: something else" });
  });
});
