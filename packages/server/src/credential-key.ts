import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const KEY_BYTES = 32;

/** AES-256-GCM (used throughout `@flowlathe/persistence`'s credential encryption) needs exactly
 *  32 bytes. Base64 decoding is lenient — a typo'd env var or a truncated/corrupted key file
 *  silently yields a wrong-length buffer, and the failure would otherwise only surface later as
 *  an opaque createCipheriv error at first use, not at boot. `name` identifies the source in the
 *  thrown message so an operator knows which of the two to fix. */
function requireKeyLength(key: Buffer, name: string): Buffer {
  if (key.length !== KEY_BYTES) {
    throw new Error(`${name} must decode to exactly ${KEY_BYTES} bytes (base64), got ${key.length}`);
  }
  return key;
}

/** Env var wins if set (base64, 32 bytes); otherwise a key file is created next to the db. */
export function resolveCredentialKey(dataDir: string): Buffer {
  const envKey = process.env["FLOWLATHE_CREDENTIAL_KEY"];
  if (envKey) return requireKeyLength(Buffer.from(envKey, "base64"), "FLOWLATHE_CREDENTIAL_KEY");

  const keyPath = join(dataDir, "credential.key");
  if (existsSync(keyPath)) return requireKeyLength(readFileSync(keyPath), "credential.key");

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}
