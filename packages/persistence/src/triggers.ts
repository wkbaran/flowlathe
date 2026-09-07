import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { putBlob } from "./blobs.js";
import type { Db } from "./db.js";
import { executionTriggers, triggerCursors, triggers } from "./schema.js";

export interface TriggerRecord {
  id: string;
  flowId: string;
  flowVersionId: string;
  source: "discord";
  configJson: unknown;
  enabled: boolean;
  createdAt: string;
}

export interface CreateTriggerInput {
  flowId: string;
  flowVersionId: string;
  source: "discord";
  config: unknown;
}

/** `flowVersionId` pins the trigger to a specific version — editing a flow on the canvas must
 *  not silently change what a live trigger does; re-pinning (deleting and recreating, in this
 *  v1) is an explicit action. */
export function createTrigger(db: Db, input: CreateTriggerInput): TriggerRecord {
  const id = randomUUID();
  db.insert(triggers)
    .values({
      id,
      flowId: input.flowId,
      flowVersionId: input.flowVersionId,
      source: input.source,
      configJson: input.config,
      enabled: true,
    })
    .run();
  return mustGetTrigger(db, id);
}

export function listTriggers(db: Db): TriggerRecord[] {
  return db.select().from(triggers).all() as TriggerRecord[];
}

export function getTrigger(db: Db, id: string): TriggerRecord | undefined {
  return db.select().from(triggers).where(eq(triggers.id, id)).get() as TriggerRecord | undefined;
}

function mustGetTrigger(db: Db, id: string): TriggerRecord {
  const row = getTrigger(db, id);
  if (!row) throw new Error(`trigger not found: ${id}`);
  return row;
}

export function setTriggerEnabled(db: Db, id: string, enabled: boolean): void {
  db.update(triggers).set({ enabled }).where(eq(triggers.id, id)).run();
}

export function deleteTrigger(db: Db, id: string): void {
  db.delete(triggers).where(eq(triggers.id, id)).run();
}

/** The dedupe **claim** — a `UNIQUE(external_id)` insert. Returns `true` if this call actually
 *  claimed the id (first time seeing it), `false` if it was already claimed (a redelivered
 *  gateway event, or a live event racing the recovery scan for the same message) — see
 *  CLAUDE.md's "ingress owns the dedup write" note. Never throws on a duplicate. */
export function claimExecutionTrigger(
  db: Db,
  input: { executionId: string; triggerId: string; source: string; externalId: string; payload: Buffer },
): boolean {
  const payloadSha = putBlob(db, input.payload);
  try {
    db.insert(executionTriggers)
      .values({
        executionId: input.executionId,
        triggerId: input.triggerId,
        source: input.source,
        externalId: input.externalId,
        payloadSha,
      })
      .run();
    return true;
  } catch {
    return false;
  }
}

/** The dedupe **check**, non-claiming — used by the post-reconnect recovery scan, which races
 *  live gateway events for the same message id (see CLAUDE.md). Never claims; only
 *  `claimExecutionTrigger`'s insert does that. */
/** For provenance/testing: every execution this trigger has ever started, oldest first. */
export function listExecutionTriggers(db: Db, triggerId: string): { executionId: string; externalId: string }[] {
  return db
    .select({ executionId: executionTriggers.executionId, externalId: executionTriggers.externalId })
    .from(executionTriggers)
    .where(eq(executionTriggers.triggerId, triggerId))
    .all();
}

export function executionTriggerExistsForExternalId(db: Db, externalId: string): boolean {
  const row = db
    .select({ externalId: executionTriggers.externalId })
    .from(executionTriggers)
    .where(eq(executionTriggers.externalId, externalId))
    .get();
  return row !== undefined;
}

/** `undefined` means this (trigger, channel) pair has never connected before — a brand-new
 *  trigger's recovery scan should replay nothing, not a channel's whole backlog. */
export function getTriggerCursor(db: Db, triggerId: string, channelId: string): string | undefined {
  const row = db
    .select({ lastMessageId: triggerCursors.lastMessageId })
    .from(triggerCursors)
    .where(and(eq(triggerCursors.triggerId, triggerId), eq(triggerCursors.channelId, channelId)))
    .get();
  return row?.lastMessageId;
}

export function setTriggerCursor(db: Db, triggerId: string, channelId: string, lastMessageId: string): void {
  db.insert(triggerCursors)
    .values({ triggerId, channelId, lastMessageId })
    .onConflictDoUpdate({
      target: [triggerCursors.triggerId, triggerCursors.channelId],
      set: { lastMessageId, updatedAt: new Date().toISOString() },
    })
    .run();
}
