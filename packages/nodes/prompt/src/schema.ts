import { z } from "zod";

export const PromptNodeDataSchema = z.object({
  label: z.string().optional(),
  template: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  /** Exposes the built-in `read_state`/`write_state` tool to this node's model. */
  enableStateTools: z.boolean().default(false),
  /** This node's own defaults — a Gate's ambient settings override these when execution has
   *  passed through one (see CLAUDE.md: a gate always wins over the node's own local value). */
  temperature: z.number().min(0).max(2).optional(),
  topK: z.number().int().positive().optional(),
});

export type PromptNodeData = z.infer<typeof PromptNodeDataSchema>;

export interface PromptSpec extends PromptNodeData {
  id: string;
  /** The node's own (unscoped) flow-graph id — set only when `id` has been scoped for a Loop/Map
   *  iteration, so conversation memory accumulates per *node*, not per iteration. Falls back to
   *  `id` when absent (every non-looped dispatch, where the two already coincide). */
  contextNodeId?: string;
}
