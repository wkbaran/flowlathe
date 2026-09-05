import type { BlobStore } from "@flowlathe/core";
import { getBlob, putBlob } from "./blobs.js";
import type { Db } from "./db.js";

export class SqliteBlobStore implements BlobStore {
  constructor(private readonly db: Db) {}

  put(bytes: Uint8Array): string {
    return putBlob(this.db, Buffer.from(bytes));
  }

  get(sha256: string): Uint8Array | undefined {
    return getBlob(this.db, sha256);
  }
}
