import { z } from "zod";

export const RouterNodeDataSchema = z.object({
  label: z.string().optional(),
  routes: z.array(z.string().min(1)).min(1),
  cases: z.array(z.object({ value: z.string(), route: z.string().min(1) })),
  defaultRoute: z.string().min(1).optional(),
});

export type RouterNodeData = z.infer<typeof RouterNodeDataSchema>;

export interface RouterSpec extends RouterNodeData {
  id: string;
}
