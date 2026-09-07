import { z } from "zod";

export const SearchNodeDataSchema = z.object({
  label: z.string().optional(),
  /** Rendered with the node's inputs (one per `{{var}}`, extracted by `extractTemplateVars` —
   *  see @flowlathe/interpreter's registry.ts) to produce the search query. */
  queryTemplate: z.string(),
  /** Fixed for v1 — SearXNG is the only search-shaped plugin. Kept as a field (not hardcoded)
   *  so `requiredToolsets` can read it generically, and so a second search-shaped plugin
   *  wouldn't need a schema migration. */
  toolset: z.literal("searxng").default("searxng"),
  limit: z.number().int().positive().max(20).optional(),
  categories: z.string().optional(),
  engines: z.string().optional(),
  timeRange: z.string().optional(),
});

export type SearchNodeData = z.infer<typeof SearchNodeDataSchema>;

export interface SearchSpec extends SearchNodeData {
  id: string;
}
