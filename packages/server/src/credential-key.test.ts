import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCredentialKey } from "./credential-key.js";

let dir: string;
const originalEnvKey = process.env["FLOWLATHE_CREDENTIAL_KEY"];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flowlathe-credential-key-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (originalEnvKey === undefined) delete process.env["FLOWLATHE_CREDENTIAL_KEY"];
  else process.env["FLOWLATHE_CREDENTIAL_KEY"] = originalEnvKey;
});

describe("resolveCredentialKey", () => {
  it("accepts a valid 32-byte base64 env key", () => {
    const valid = randomBytes(32).toString("base64");
    process.env["FLOWLATHE_CREDENTIAL_KEY"] = valid;
    const key = resolveCredentialKey(dir);
    expect(key).toEqual(Buffer.from(valid, "base64"));
    expect(key.length).toBe(32);
  });

  it("throws naming the env var for a too-short env key", () => {
    process.env["FLOWLATHE_CREDENTIAL_KEY"] = randomBytes(16).toString("base64");
    expect(() => resolveCredentialKey(dir)).toThrow(/FLOWLATHE_CREDENTIAL_KEY/);
  });

  it("throws for non-base64 env input that decodes to the wrong length", () => {
    process.env["FLOWLATHE_CREDENTIAL_KEY"] = "not valid base64 at all!!";
    expect(() => resolveCredentialKey(dir)).toThrow(/FLOWLATHE_CREDENTIAL_KEY/);
  });

  it("creates a fresh 32-byte key file with 0o600 permissions and a 0o700 data dir when none exists", () => {
    delete process.env["FLOWLATHE_CREDENTIAL_KEY"];
    const nested = join(dir, "nested");
    const key = resolveCredentialKey(nested);
    expect(key.length).toBe(32);
    expect(statSync(join(nested, "credential.key")).mode & 0o777).toBe(0o600);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });

  it("throws naming the key file for a corrupted on-disk key", () => {
    delete process.env["FLOWLATHE_CREDENTIAL_KEY"];
    writeFileSync(join(dir, "credential.key"), Buffer.from("short"), { mode: 0o600 });
    expect(() => resolveCredentialKey(dir)).toThrow(/credential\.key/);
  });

  it("reuses an existing valid on-disk key across calls", () => {
    delete process.env["FLOWLATHE_CREDENTIAL_KEY"];
    const first = resolveCredentialKey(dir);
    const second = resolveCredentialKey(dir);
    expect(second).toEqual(first);
    expect(readFileSync(join(dir, "credential.key"))).toEqual(first);
  });
});
