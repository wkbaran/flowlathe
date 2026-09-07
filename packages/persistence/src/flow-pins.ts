import { and, eq } from "drizzle-orm";
import type { Db } from "./db.js";
import { flowPins } from "./schema.js";

export interface FlowPin {
  flowId: string;
  channel: string;
  flowVersionId: string;
  updatedAt: string;
}

/** Points `channel` at `flowVersionId` — an explicit action, never re-resolved to HEAD later
 *  (PLAN-FLOW-VERSIONING.md §6). Upserts: re-pinning the same channel just moves it. */
export function setFlowPin(db: Db, flowId: string, channel: string, flowVersionId: string): FlowPin {
  const existing = db
    .select()
    .from(flowPins)
    .where(and(eq(flowPins.flowId, flowId), eq(flowPins.channel, channel)))
    .get();
  if (existing) {
    db.update(flowPins)
      .set({ flowVersionId, updatedAt: new Date().toISOString() })
      .where(and(eq(flowPins.flowId, flowId), eq(flowPins.channel, channel)))
      .run();
  } else {
    db.insert(flowPins).values({ flowId, channel, flowVersionId }).run();
  }
  return db
    .select()
    .from(flowPins)
    .where(and(eq(flowPins.flowId, flowId), eq(flowPins.channel, channel)))
    .get()!;
}

export function getFlowPin(db: Db, flowId: string, channel: string): FlowPin | undefined {
  return db
    .select()
    .from(flowPins)
    .where(and(eq(flowPins.flowId, flowId), eq(flowPins.channel, channel)))
    .get();
}

export function listFlowPins(db: Db, flowId: string): FlowPin[] {
  return db.select().from(flowPins).where(eq(flowPins.flowId, flowId)).all();
}

export function deleteFlowPin(db: Db, flowId: string, channel: string): void {
  db.delete(flowPins).where(and(eq(flowPins.flowId, flowId), eq(flowPins.channel, channel))).run();
}
