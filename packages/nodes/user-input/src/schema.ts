import { z } from "zod";

export const UserInputNodeDataSchema = z.object({
  label: z.string().optional(),
  prompt: z.string().min(1),
});

export type UserInputNodeData = z.infer<typeof UserInputNodeDataSchema>;

export interface UserInputSpec extends UserInputNodeData {
  id: string;
}
