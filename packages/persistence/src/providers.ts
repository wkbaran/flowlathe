import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./credentials.js";
import type { Db } from "./db.js";
import { providers } from "./schema.js";

export type ProviderKind = "mock" | "ollama" | "openai-compat";

export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  baseUrl?: string | undefined;
  secret?: string | undefined;
  maxParallel?: number | undefined;
  rpm?: number | undefined;
  tpm?: number | undefined;
  swapCostMs?: number | undefined;
  residentModels?: number | undefined;
}

export interface ProviderRecord {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  hasSecret: boolean;
  maxParallel: number;
  rpm: number | null;
  tpm: number | null;
  swapCostMs: number | null;
  residentModels: number;
}

function toRecord(row: typeof providers.$inferSelect): ProviderRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    hasSecret: row.secretEnc !== null,
    maxParallel: row.maxParallel,
    rpm: row.rpm,
    tpm: row.tpm,
    swapCostMs: row.swapCostMs,
    residentModels: row.residentModels,
  };
}

export function createProvider(db: Db, credentialKey: Buffer, input: ProviderInput): ProviderRecord {
  const id = randomUUID();
  db.insert(providers)
    .values({
      id,
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl ?? null,
      secretEnc: input.secret ? encryptSecret(credentialKey, input.secret) : null,
      maxParallel: input.maxParallel ?? 1,
      rpm: input.rpm ?? null,
      tpm: input.tpm ?? null,
      swapCostMs: input.swapCostMs ?? null,
      residentModels: input.residentModels ?? 1,
    })
    .run();
  return toRecord(mustGetRow(db, id));
}

export function listProviders(db: Db): ProviderRecord[] {
  return db.select().from(providers).all().map(toRecord);
}

/** Seeds the always-available "mock" provider with a fixed id, if it doesn't exist yet. */
export function ensureDefaultMockProvider(db: Db): void {
  const existing = db.select({ id: providers.id }).from(providers).where(eq(providers.id, "mock")).get();
  if (existing) return;
  db.insert(providers).values({ id: "mock", name: "Mock", kind: "mock", maxParallel: 4, residentModels: 1 }).run();
}

export function getProvider(db: Db, id: string): ProviderRecord | undefined {
  const row = db.select().from(providers).where(eq(providers.id, id)).get();
  return row ? toRecord(row) : undefined;
}

export type ProviderPatch = { [K in keyof ProviderInput]?: ProviderInput[K] | undefined };

export function updateProvider(db: Db, credentialKey: Buffer, id: string, patch: ProviderPatch): ProviderRecord {
  const existing = mustGetRow(db, id);
  db.update(providers)
    .set({
      name: patch.name ?? existing.name,
      kind: patch.kind ?? existing.kind,
      baseUrl: patch.baseUrl !== undefined ? patch.baseUrl : existing.baseUrl,
      secretEnc: patch.secret !== undefined ? encryptSecret(credentialKey, patch.secret) : existing.secretEnc,
      maxParallel: patch.maxParallel ?? existing.maxParallel,
      rpm: patch.rpm !== undefined ? patch.rpm : existing.rpm,
      tpm: patch.tpm !== undefined ? patch.tpm : existing.tpm,
      swapCostMs: patch.swapCostMs !== undefined ? patch.swapCostMs : existing.swapCostMs,
      residentModels: patch.residentModels ?? existing.residentModels,
    })
    .where(eq(providers.id, id))
    .run();
  return toRecord(mustGetRow(db, id));
}

export function deleteProvider(db: Db, id: string): void {
  db.delete(providers).where(eq(providers.id, id)).run();
}

/** Decrypts and returns a provider's secret. Never expose this over the API. */
export function getProviderSecret(db: Db, credentialKey: Buffer, id: string): string | undefined {
  const row = mustGetRow(db, id);
  return row.secretEnc ? decryptSecret(credentialKey, row.secretEnc) : undefined;
}

function mustGetRow(db: Db, id: string): typeof providers.$inferSelect {
  const row = db.select().from(providers).where(eq(providers.id, id)).get();
  if (!row) throw new Error(`provider not found: ${id}`);
  return row;
}
