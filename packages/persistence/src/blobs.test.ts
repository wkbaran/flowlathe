import { beforeEach, describe, expect, it } from "vitest";
import { getBlob, putBlob, sha256Of } from "./blobs.js";
import { type OpenedDb, openDb } from "./db.js";
import { runMigrations } from "./migrate.js";

let opened: OpenedDb;

beforeEach(() => {
  opened = openDb(":memory:");
  runMigrations(opened);
});

describe("blob store", () => {
  it("is content-addressed: identical bytes produce the same sha256", () => {
    const bytes = Buffer.from("hello flowlathe", "utf-8");
    const a = putBlob(opened.db, bytes);
    const b = putBlob(opened.db, bytes);
    expect(a).toBe(b);
    expect(a).toBe(sha256Of(bytes));
  });

  it("round-trips bytes through get/put", () => {
    const bytes = Buffer.from("some prompt output", "utf-8");
    const sha = putBlob(opened.db, bytes);
    expect(getBlob(opened.db, sha)).toEqual(bytes);
  });

  it("returns undefined for an unknown sha256", () => {
    expect(getBlob(opened.db, "0".repeat(64))).toBeUndefined();
  });
});
