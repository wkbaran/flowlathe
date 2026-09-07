import type { BlobStore } from "@flowlathe/core";
import { getBlob, putBlob } from "./blobs.js";
import type { Db } from "./db.js";

export class SqliteBlobStore implements BlobStore {
  constructor(private readonly db: Db) {}

  /** Produces an unrooted blob: nothing but content-addressing ties the returned sha to anything
   *  execution-gc.ts's liveness sweep can see. A future caller of this should either root the
   *  returned sha in a row GC can find, or that sweep needs an explicit exemption for it — see
   *  CLAUDE.md's PLAN-EXECUTION-RETENTION.md note. Because blobs are content-addressed, put()-ing
   *  bytes identical to a value some execution already owns returns that SAME row, so deleting
   *  that execution collects it out from under this unrelated caller too. */
  put(bytes: Uint8Array): string {
    return putBlob(this.db, Buffer.from(bytes));
  }

  get(sha256: string): Uint8Array | undefined {
    return getBlob(this.db, sha256);
  }
}
