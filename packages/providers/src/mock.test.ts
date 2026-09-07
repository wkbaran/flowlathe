import { describe, expect, it } from "vitest";
import { MissingMockResponse, MockProviderAdapter, mockResponseKey } from "./mock.js";

describe("MockProviderAdapter", () => {
  it("echoes deterministically when no response table is given", async () => {
    const adapter = new MockProviderAdapter();
    const a = await adapter.call({ providerId: "mock", modelId: "m", nodeId: "n1", prompt: "hi" });
    const b = await adapter.call({ providerId: "mock", modelId: "m", nodeId: "n1", prompt: "hi" });
    expect(a.content).toBe(b.content);
  });

  it("looks up a canned response by (nodeId, sha256(prompt))", async () => {
    const key = mockResponseKey("n1", "hi");
    const adapter = new MockProviderAdapter({ responses: new Map([[key, "canned"]]) });
    const result = await adapter.call({ providerId: "mock", modelId: "m", nodeId: "n1", prompt: "hi" });
    expect(result.content).toBe("canned");
  });

  it("throws MissingMockResponse for an unregistered key rather than guessing", async () => {
    const adapter = new MockProviderAdapter({ responses: new Map() });
    await expect(
      adapter.call({ providerId: "mock", modelId: "m", nodeId: "n1", prompt: "hi" }),
    ).rejects.toThrow(MissingMockResponse);
  });

  it("FAIL: throws an error with the given message", async () => {
    const adapter = new MockProviderAdapter();
    await expect(
      adapter.call({ providerId: "mock", modelId: "m", nodeId: "n1", prompt: "FAIL: boom node exploded" }),
    ).rejects.toThrow("boom node exploded");
  });

  it("DELAY_MS: waits, then falls through to the ordinary echo response", async () => {
    const adapter = new MockProviderAdapter();
    const start = Date.now();
    const result = await adapter.call({ providerId: "mock", modelId: "m", nodeId: "n1", prompt: "DELAY_MS: 30 slow node" });
    // A generous tolerance below the requested delay: timer resolution/coalescing can make an
    // elapsed-time assertion flaky at very small delays, and the point of this test is "it waited
    // roughly that long," not the exact millisecond.
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
    expect(result.content).toContain("DELAY_MS: 30 slow node");
  });

  it("DELAY_MS: rejects with the abort reason once the signal fires, rather than waiting out the delay", async () => {
    const adapter = new MockProviderAdapter();
    const controller = new AbortController();
    const promise = adapter.call({
      providerId: "mock",
      modelId: "m",
      nodeId: "n1",
      prompt: "DELAY_MS: 2000 slow node",
      signal: controller.signal,
    });
    controller.abort(new Error("cancelled"));
    await expect(promise).rejects.toThrow("cancelled");
  });

  it("DELAY_MS: rejects immediately for an already-aborted signal", async () => {
    const adapter = new MockProviderAdapter();
    const controller = new AbortController();
    controller.abort(new Error("already gone"));
    await expect(
      adapter.call({
        providerId: "mock",
        modelId: "m",
        nodeId: "n1",
        prompt: "DELAY_MS: 2000 slow node",
        signal: controller.signal,
      }),
    ).rejects.toThrow("already gone");
  });
});
