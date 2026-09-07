import { z } from "zod";

export const TriggerNodeDataSchema = z.object({
  label: z.string().optional(),
  source: z.enum(["discord", "manual"]).default("manual"),
  /** Restricts which channels a Discord-sourced trigger fires from — advisory here; the real
   *  enforcement is the trigger registration's own channel allowlist (see
   *  `@flowlathe/plugin-discord`'s `DISCORD_ALLOWED_CHANNELS` and PLAN-INTEGRATIONS.md §7). */
  channelIds: z.array(z.string()).optional(),
  /** What this node resolves to when a flow is started from the canvas (`/run`, `/step-start`)
   *  — a trigger node's outputs are otherwise *seeded* by the real event, never dispatched
   *  normally, when a flow is started by an actual trigger source. */
  testPayload: z.string().default(""),
});

export type TriggerNodeData = z.infer<typeof TriggerNodeDataSchema>;

export interface TriggerSpec extends TriggerNodeData {
  id: string;
}
