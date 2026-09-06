import { z } from "zod";

export const LoopNodeDataSchema = z.object({
  label: z.string().optional(),
  initTemplate: z.string(),
  /** The body node's input port that receives the running accumulator each iteration. */
  accPortName: z.string().min(1),
  /** The loop stops once the body's output equals this value, or maxIterations is hit. */
  stopValue: z.string(),
  maxIterations: z.number().int().positive(),
});

export type LoopNodeData = z.infer<typeof LoopNodeDataSchema>;

export interface LoopSpec extends LoopNodeData {
  id: string;
}
