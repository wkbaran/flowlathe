import { z } from "zod";

export const PauseNodeDataSchema = z.object({
  label: z.string().optional(),
  message: z.string().optional(),
});

export type PauseNodeData = z.infer<typeof PauseNodeDataSchema>;

export interface PauseSpec extends PauseNodeData {
  id: string;
}
