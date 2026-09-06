import { z } from "zod";

export const ContextRoleSchema = z.enum(["system", "user", "assistant", "thinking", "tool"]);
export type ContextRole = z.infer<typeof ContextRoleSchema>;

export const ContextMessageSchema = z.object({
  role: ContextRoleSchema,
  content: z.string(),
});
export type ContextMessage = z.infer<typeof ContextMessageSchema>;

/**
 * Compaction methods a Gate can name. There's no per-call config for *how much* to cut — these
 * are deliberately parameter-free, automatic policies (unlike Slice 5's ContextTransform node,
 * which took explicit indices/role lists): a Gate only decides *whether* to fire (via its
 * threshold) and *which* policy runs, not the specifics. `system`-role messages are always kept.
 */
export const CompactionMethodSchema = z.enum(["drop-oldest-half", "summarize-oldest-half"]);
export type CompactionMethod = z.infer<typeof CompactionMethodSchema>;

export const CompactionThresholdSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed"), tokens: z.number().int().positive() }),
  z.object({ kind: z.literal("percentage"), percent: z.number().min(1).max(100), contextWindowTokens: z.number().int().positive() }),
]);
export type CompactionThreshold = z.infer<typeof CompactionThresholdSchema>;

/** "Flat text rendered on demand" — how a node's ambient context is folded into its next call. */
export function renderContextText(messages: ContextMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}

/** Rough, provider-agnostic heuristic (~4 chars/token in English) — good enough to decide
 *  "are we near the window," not meant to match any real tokenizer exactly. */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

export function thresholdTokens(threshold: CompactionThreshold): number {
  return threshold.kind === "fixed" ? threshold.tokens : Math.floor(threshold.contextWindowTokens * (threshold.percent / 100));
}

/** The oldest half of non-`system` messages vs. the half that's kept as-is — the split every
 *  compaction method starts from. `system` messages (the standing instructions) are never cut. */
export function splitOldestHalf(messages: ContextMessage[]): {
  system: ContextMessage[];
  toCompact: ContextMessage[];
  rest: ContextMessage[];
} {
  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");
  const cut = Math.ceil(nonSystem.length / 2);
  return { system, toCompact: nonSystem.slice(0, cut), rest: nonSystem.slice(cut) };
}

export function dropOldestHalf(messages: ContextMessage[]): ContextMessage[] {
  const { system, rest } = splitOldestHalf(messages);
  return [...system, ...rest];
}

/** Ambient LLM call settings a Gate can override. Unset fields fall through to the node's own
 *  local config; set fields always win over the node's local value (a Gate overrides, by design). */
export interface LlmConfig {
  temperature?: number;
  topK?: number;
  compactionMethod?: CompactionMethod;
  compactionThreshold?: CompactionThreshold;
}

/** One gate's worth of ambient settings, applied the moment execution passes through it. */
export interface LlmConfigStore {
  get(): LlmConfig;
  set(patch: LlmConfig): void;
}

/**
 * Per-node conversation memory: every prompt call appends its own turn automatically, keyed by
 * the flow node's static id (not its scoped activation key) so a Loop/Map body node accumulates
 * across iterations rather than starting fresh each time.
 */
export interface ContextStore {
  get(nodeId: string): ContextMessage[];
  append(nodeId: string, turns: ContextMessage[]): void;
  replace(nodeId: string, messages: ContextMessage[]): void;
}
