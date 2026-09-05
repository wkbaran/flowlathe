import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./credentials.js";

describe("credentials", () => {
  it("round-trips a secret through encrypt/decrypt", () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret(key, "sk-super-secret");
    expect(encrypted).not.toContain("sk-super-secret");
    expect(decryptSecret(key, encrypted)).toBe("sk-super-secret");
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = encryptSecret(randomBytes(32), "sk-super-secret");
    expect(() => decryptSecret(randomBytes(32), encrypted)).toThrow();
  });
});
