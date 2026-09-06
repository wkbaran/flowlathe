import type { ContextMessage, RunEvent, RuntimeHost } from "@flowlathe/core";
import { serializeContextValue } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { runContextTransform } from "./run.js";
import type { ContextTransformSpec } from "./schema.js";

function fakeCtx(overrides: Partial<RuntimeHost> = {}): { ctx: RuntimeHost; events: RunEvent[] } {
  const events: RunEvent[] = [];
  const ctx: RuntimeHost = {
    scheduler: { submit: async (req) => ({ content: `summary of: ${req.prompt}`, finishReason: "stop" }) },
    blobs: { put: () => "", get: () => undefined },
    emit: (event) => events.push(event),
    clock: { now: () => 0 },
    suspend: () => new Promise(() => undefined),
    resolveSuspended: () => undefined,
    state: { read: () => undefined, write: () => undefined },
    ...overrides,
  };
  return { ctx, events };
}

function spec(overrides: Partial<ContextTransformSpec>): ContextTransformSpec {
  return { id: "ctx1", transformKind: "append", startsNewContext: false, ...overrides };
}

const seed: ContextMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
  { role: "assistant", content: "hello" },
];

describe("runContextTransform", () => {
  it("append: adds one message and preserves the rest", async () => {
    const { ctx } = fakeCtx();
    const result = await runContextTransform(
      ctx,
      spec({ transformKind: "append", appendRole: "user", appendTemplate: "more: {{extra}}" }),
      { context: serializeContextValue(seed), extra: "please" },
    );
    expect(JSON.parse(result.context)).toEqual([...seed, { role: "user", content: "more: please" }]);
    expect(result.output).toContain("user: more: please");
  });

  it("append with startsNewContext: true ignores any prior context and starts fresh", async () => {
    const { ctx } = fakeCtx();
    const result = await runContextTransform(
      ctx,
      spec({ transformKind: "append", appendRole: "system", appendTemplate: "seed", startsNewContext: true }),
      {},
    );
    expect(JSON.parse(result.context)).toEqual([{ role: "system", content: "seed" }]);
  });

  it("drop-before: keeps only messages from the given index onward", async () => {
    const { ctx } = fakeCtx();
    const result = await runContextTransform(ctx, spec({ transformKind: "drop-before", keepFromIndex: 2 }), {
      context: serializeContextValue(seed),
    });
    expect(JSON.parse(result.context)).toEqual([{ role: "assistant", content: "hello" }]);
  });

  it("filter-role: removes every message with an excluded role", async () => {
    const { ctx } = fakeCtx();
    const result = await runContextTransform(ctx, spec({ transformKind: "filter-role", excludeRoles: ["system"] }), {
      context: serializeContextValue(seed),
    });
    expect(JSON.parse(result.context)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("summarize: replaces the summarized prefix with one message from its own model call", async () => {
    const { ctx } = fakeCtx();
    const result = await runContextTransform(
      ctx,
      spec({ transformKind: "summarize", summarizeBeforeIndex: 2, providerId: "mock", modelId: "m" }),
      { context: serializeContextValue(seed) },
    );
    const messages = JSON.parse(result.context) as ContextMessage[];
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("summary of:");
    expect(messages[1]).toEqual({ role: "assistant", content: "hello" });
  });

  it("summarize: throws without a provider/model configured", async () => {
    const { ctx } = fakeCtx();
    await expect(
      runContextTransform(ctx, spec({ transformKind: "summarize" }), { context: serializeContextValue(seed) }),
    ).rejects.toThrow(/requires a provider and model/);
  });

  it("emits node_started, node_finished, and context_transform in order", async () => {
    const { ctx, events } = fakeCtx();
    await runContextTransform(ctx, spec({ transformKind: "drop-before", keepFromIndex: 0 }), {
      context: serializeContextValue(seed),
    });
    expect(events.map((e) => e.kind)).toEqual(["node_started", "node_finished", "context_transform"]);
  });
});
