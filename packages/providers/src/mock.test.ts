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
});
