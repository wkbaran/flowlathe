import { z } from "zod";

export const FetchNodeDataSchema = z.object({
  label: z.string().optional(),
  /** Rendered with the node's inputs (one per `{{var}}`) to produce the URL to scrape. */
  urlTemplate: z.string(),
  /** Fixed for v1 — Firecrawl is the only scrape-shaped plugin. A field, not hardcoded, for the
   *  same reason as `search`'s `toolset` field (see that schema's comment). */
  toolset: z.literal("firecrawl").default("firecrawl"),
  format: z.enum(["markdown", "html"]).default("markdown"),
  maxChars: z.number().int().positive().optional(),
});

export type FetchNodeData = z.infer<typeof FetchNodeDataSchema>;

export interface FetchSpec extends FetchNodeData {
  id: string;
}
