import { z } from "zod";

export const ContextRoleSchema = z.enum(["system", "user", "assistant", "thinking", "tool"]);
export type ContextRole = z.infer<typeof ContextRoleSchema>;

export const ContextMessageSchema = z.object({
  role: ContextRoleSchema,
  content: z.string(),
});
export type ContextMessage = z.infer<typeof ContextMessageSchema>;

export const ContextTransformKindSchema = z.enum(["append", "drop-before", "filter-role", "summarize"]);
export type ContextTransformKind = z.infer<typeof ContextTransformKindSchema>;

/** A context flows through a port as JSON — parsed back into a message list on demand. */
export function parseContextValue(raw: string | undefined): ContextMessage[] {
  if (!raw) return [];
  return z.array(ContextMessageSchema).parse(JSON.parse(raw));
}

export function serializeContextValue(messages: ContextMessage[]): string {
  return JSON.stringify(messages);
}

/** "Flat text rendered on demand" — how a context is consumed by anything that only understands
 *  plain-string template variables (e.g. a PromptNode's `{{ctx}}`). */
export function renderContextText(messages: ContextMessage[]): string {
  return messages.map((m) => `${m.role}: ${m.content}`).join("\n");
}
