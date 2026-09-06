import { CompactionMethodSchema, CompactionThresholdSchema } from "@flowlathe/core";
import { z } from "zod";

export const GateNodeDataSchema = z.object({
  label: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topK: z.number().int().positive().optional(),
  compactionMethod: CompactionMethodSchema.optional(),
  compactionThreshold: CompactionThresholdSchema.optional(),
});

export type GateNodeData = z.infer<typeof GateNodeDataSchema>;

export interface GateSpec extends GateNodeData {
  id: string;
}
