import { createRunControl, type RunEvent, type RuntimeHost } from "@flowlathe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFetch } from "./run.js";

function fakeFetch(handler: (url: URL) => Response): typeof fetch {
  return (async (input: string | URL) => handler(new URL(String(input)))) as typeof fetch;
}

function fakeCtx(fetchImpl: typeof fetch): { ctx: RuntimeHost; events: RunEvent[] } {
  const events: RunEvent[] = [];
  const ctx: RuntimeHost = {
    scheduler: { submit: async () => ({ content: "", finishReason: "stop" }) },
    blobs: { put: () => "", get: () => undefined },
    emit: (event) => events.push(event),
    clock: { now: () => 0 },
    suspend: () => new Promise(() => undefined),
    resolveSuspended: () => undefined,
    state: { read: () => undefined, write: () => undefined },
    llmConfig: { get: () => ({}), set: () => undefined },
    context: { get: () => [], append: () => undefined, replace: () => undefined },
    tools: { specsFor: () => [], invoke: async () => "", missingToolsets: () => [] },
    cancellation: createRunControl(),
    net: { fetch: fetchImpl },
  };
  return { ctx, events };
}

describe("runFetch", () => {
  beforeEach(() => {
    vi.stubEnv("FIRECRAWL_API_KEY", "key");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the url template, scrapes, and returns the page content", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ data: { markdown: "hi", metadata: { sourceURL: "https://example.com/" } } }), { status: 200 }),
    );
    const { ctx, events } = fakeCtx(fetchImpl);
    const result = await runFetch(ctx, { id: "f", urlTemplate: "{{u}}", toolset: "firecrawl", format: "markdown" }, { u: "https://example.com/" });
    expect(result.content).toBe("hi");
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_finished"]);
  });

  it("fails the node when FIRECRAWL_API_KEY isn't configured", async () => {
    vi.unstubAllEnvs();
    const { ctx, events } = fakeCtx(fakeFetch(() => new Response("{}", { status: 200 })));
    await expect(
      runFetch(ctx, { id: "f", urlTemplate: "https://example.com/", toolset: "firecrawl", format: "markdown" }, {}),
    ).rejects.toThrow(/not configured/);
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_failed"]);
  });

  it("fails the node (not silently empty) when the URL is blocked by URL safety", async () => {
    const { ctx, events } = fakeCtx(fakeFetch(() => new Response("{}", { status: 200 })));
    await expect(
      runFetch(ctx, { id: "f", urlTemplate: "http://127.0.0.1/admin", toolset: "firecrawl", format: "markdown" }, {}),
    ).rejects.toThrow(/private or internal/);
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_failed"]);
  });
});
