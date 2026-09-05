import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "./db.js";
import { models } from "./schema.js";

export interface ModelInput {
  providerId: string;
  modelName: string;
  contextWindow?: number | undefined;
  defaultsJson?: unknown;
}

export interface ModelRecord {
  id: string;
  providerId: string;
  modelName: string;
  contextWindow: number | null;
  defaultsJson: unknown;
}

export function createModel(db: Db, input: ModelInput): ModelRecord {
  const id = randomUUID();
  db.insert(models)
    .values({
      id,
      providerId: input.providerId,
      modelName: input.modelName,
      contextWindow: input.contextWindow ?? null,
      defaultsJson: input.defaultsJson ?? null,
    })
    .run();
  return mustGetRow(db, id);
}

export function listModels(db: Db, providerId?: string): ModelRecord[] {
  if (providerId) {
    return db.select().from(models).where(eq(models.providerId, providerId)).all();
  }
  return db.select().from(models).all();
}

export function deleteModel(db: Db, id: string): void {
  db.delete(models).where(eq(models.id, id)).run();
}

function mustGetRow(db: Db, id: string): ModelRecord {
  const row = db.select().from(models).where(eq(models.id, id)).get();
  if (!row) throw new Error(`model not found: ${id}`);
  return row;
}
