import { z } from "zod";

export const PromptNodeDataSchema = z.object({
  label: z.string().optional(),
  template: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
});

export type PromptNodeData = z.infer<typeof PromptNodeDataSchema>;

export interface PromptSpec extends PromptNodeData {
  id: string;
}
