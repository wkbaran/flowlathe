import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

/** Env var wins if set (base64, 32 bytes); otherwise a key file is created next to the db. */
export function resolveCredentialKey(dataDir: string): Buffer {
  const envKey = process.env["FLOWLATHE_CREDENTIAL_KEY"];
  if (envKey) return Buffer.from(envKey, "base64");

  const keyPath = join(dataDir, "credential.key");
  if (existsSync(keyPath)) return readFileSync(keyPath);

  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}
