import { z } from "zod";

export const PromptNodeDataSchema = z.object({
  label: z.string().optional(),
  template: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  /** Exposes the built-in `read_state`/`write_state` tool to this node's model. */
  enableStateTools: z.boolean().default(false),
});

export type PromptNodeData = z.infer<typeof PromptNodeDataSchema>;

export interface PromptSpec extends PromptNodeData {
  id: string;
}
