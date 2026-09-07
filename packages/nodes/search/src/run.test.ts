import { createRunControl, type RunEvent, type RuntimeHost } from "@flowlathe/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runSearch } from "./run.js";

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

describe("runSearch", () => {
  beforeEach(() => {
    vi.stubEnv("SEARXNG_BASE_URL", "http://searxng.invalid");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("renders the query template, searches, and returns a trimmed JSON array", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ results: [{ title: "T", url: "https://example.com", content: "snippet", score: 1, engine: "google" }] }),
          { status: 200 },
        ),
    );
    const { ctx, events } = fakeCtx(fetchImpl);
    const result = await runSearch(ctx, { id: "s", queryTemplate: "{{q}}", toolset: "searxng" }, { q: "flowlathe" });
    expect(JSON.parse(result.results)).toEqual([{ title: "T", url: "https://example.com", snippet: "snippet", engine: "google" }]);
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_finished"]);
    const finished = events.find((e) => e.kind === "node_finished");
    expect(finished && "renderedPrompt" in finished && finished.renderedPrompt).toBe("flowlathe");
  });

  it("fails the node when SEARXNG_BASE_URL isn't configured", async () => {
    vi.unstubAllEnvs();
    const { ctx, events } = fakeCtx(fakeFetch(() => new Response("{}", { status: 200 })));
    await expect(runSearch(ctx, { id: "s", queryTemplate: "q", toolset: "searxng" }, {})).rejects.toThrow(/not configured/);
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_failed"]);
  });

  it("fails the node (not silently empty) when the search request fails", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const { ctx, events } = fakeCtx(fetchImpl);
    await expect(runSearch(ctx, { id: "s", queryTemplate: "q", toolset: "searxng" }, {})).rejects.toThrow(/could not reach/);
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_failed"]);
  });
});
