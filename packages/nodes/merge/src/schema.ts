import { z } from "zod";

export const MergeNodeDataSchema = z.object({
  label: z.string().optional(),
});

export type MergeNodeData = z.infer<typeof MergeNodeDataSchema>;

export interface MergeSpec extends MergeNodeData {
  id: string;
}
