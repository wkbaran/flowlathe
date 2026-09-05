import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { blobs } from "./schema.js";

export type Sha256Hex = string;

export function sha256Of(bytes: Buffer): Sha256Hex {
  return createHash("sha256").update(bytes).digest("hex");
}

export function putBlob(db: Db, bytes: Buffer, encoding = "utf-8"): Sha256Hex {
  const sha256 = sha256Of(bytes);
  db.insert(blobs)
    .values({ sha256, bytes, byteLen: bytes.byteLength, encoding, refcount: 1 })
    .onConflictDoUpdate({
      target: blobs.sha256,
      set: { refcount: sql`${blobs.refcount} + 1` },
    })
    .run();
  return sha256;
}

export function getBlob(db: Db, sha256: Sha256Hex): Buffer | undefined {
  const row = db.select({ bytes: blobs.bytes }).from(blobs).where(eq(blobs.sha256, sha256)).get();
  return row?.bytes;
}

export function releaseBlob(db: Db, sha256: Sha256Hex): void {
  db.update(blobs)
    .set({ refcount: sql`${blobs.refcount} - 1` })
    .where(eq(blobs.sha256, sha256))
    .run();
}
