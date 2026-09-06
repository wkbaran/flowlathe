import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "./credentials.js";
import type { Db } from "./db.js";
import { pluginCredentials } from "./schema.js";

/** Stores/reads a plugin's opaque credential payload (e.g. a Spotify refresh token) as a single
 *  encrypted string, keyed by plugin id. What's inside is the plugin's own business — persistence
 *  just gives every plugin the same encrypted-at-rest storage `providers.secretEnc` already has. */
export function getPluginCredential(db: Db, credentialKey: Buffer, pluginId: string): string | undefined {
  const row = db.select().from(pluginCredentials).where(eq(pluginCredentials.pluginId, pluginId)).get();
  return row ? decryptSecret(credentialKey, row.secretEnc) : undefined;
}

export function setPluginCredential(db: Db, credentialKey: Buffer, pluginId: string, secret: string): void {
  const secretEnc = encryptSecret(credentialKey, secret);
  db.insert(pluginCredentials)
    .values({ pluginId, secretEnc })
    .onConflictDoUpdate({ target: pluginCredentials.pluginId, set: { secretEnc, updatedAt: new Date().toISOString() } })
    .run();
}

export function deletePluginCredential(db: Db, pluginId: string): void {
  db.delete(pluginCredentials).where(eq(pluginCredentials.pluginId, pluginId)).run();
}

export function hasPluginCredential(db: Db, pluginId: string): boolean {
  const row = db.select({ pluginId: pluginCredentials.pluginId }).from(pluginCredentials).where(eq(pluginCredentials.pluginId, pluginId)).get();
  return row !== undefined;
}
