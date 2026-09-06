import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { type OpenedDb, openDb } from "./db.js";
import { runMigrations } from "./migrate.js";
import { deletePluginCredential, getPluginCredential, hasPluginCredential, setPluginCredential } from "./plugin-credentials.js";

let opened: OpenedDb;
let key: Buffer;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
  key = randomBytes(32);
});

describe("plugin credential store", () => {
  it("has none for a plugin that was never connected", () => {
    expect(hasPluginCredential(opened.db, "spotify")).toBe(false);
    expect(getPluginCredential(opened.db, key, "spotify")).toBeUndefined();
  });

  it("stores and decrypts a credential, never storing it in plaintext", () => {
    setPluginCredential(opened.db, key, "spotify", "refresh-token-abc");
    expect(hasPluginCredential(opened.db, "spotify")).toBe(true);
    expect(getPluginCredential(opened.db, key, "spotify")).toBe("refresh-token-abc");

    const raw = opened.sqlite.prepare("select secret_enc from plugin_credentials where plugin_id = ?").get("spotify") as {
      secret_enc: string;
    };
    expect(raw.secret_enc).not.toContain("refresh-token-abc");
  });

  it("overwrites an existing credential for the same plugin", () => {
    setPluginCredential(opened.db, key, "spotify", "first-token");
    setPluginCredential(opened.db, key, "spotify", "second-token");
    expect(getPluginCredential(opened.db, key, "spotify")).toBe("second-token");
  });

  it("deletes a credential", () => {
    setPluginCredential(opened.db, key, "spotify", "a-token");
    deletePluginCredential(opened.db, "spotify");
    expect(hasPluginCredential(opened.db, "spotify")).toBe(false);
  });

  it("keeps different plugins' credentials independent", () => {
    setPluginCredential(opened.db, key, "spotify", "spotify-token");
    setPluginCredential(opened.db, key, "other-plugin", "other-token");
    expect(getPluginCredential(opened.db, key, "spotify")).toBe("spotify-token");
    expect(getPluginCredential(opened.db, key, "other-plugin")).toBe("other-token");
  });
});
