import { ContextRoleSchema, ContextTransformKindSchema } from "@flowlathe/core";
import { z } from "zod";

export const ContextTransformNodeDataSchema = z.object({
  label: z.string().optional(),
  transformKind: ContextTransformKindSchema,
  /** No incoming `context` edge — this node starts a brand-new context chain. */
  startsNewContext: z.boolean().default(false),

  // transformKind: "append"
  appendRole: ContextRoleSchema.optional(),
  appendTemplate: z.string().optional(),

  // transformKind: "drop-before"
  keepFromIndex: z.number().int().min(0).optional(),

  // transformKind: "filter-role"
  excludeRoles: z.array(ContextRoleSchema).optional(),

  // transformKind: "summarize" — runs on its own provider/model, independent of any node
  // downstream that consumes the resulting context.
  summarizeBeforeIndex: z.number().int().min(0).optional(),
  summarizeTemplate: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
});

export type ContextTransformNodeData = z.infer<typeof ContextTransformNodeDataSchema>;

export interface ContextTransformSpec extends ContextTransformNodeData {
  id: string;
}
