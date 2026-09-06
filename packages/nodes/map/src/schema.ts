import { z } from "zod";

export const MapNodeDataSchema = z.object({
  label: z.string().optional(),
  /** Must render to a JSON array of strings, e.g. `["a","b","c"]`. */
  itemsTemplate: z.string(),
  /** The body node's input port that receives the current item each iteration. */
  itemPortName: z.string().min(1),
  maxConcurrency: z.number().int().positive(),
  maxItems: z.number().int().positive(),
});

export type MapNodeData = z.infer<typeof MapNodeDataSchema>;

export interface MapSpec extends MapNodeData {
  id: string;
}
