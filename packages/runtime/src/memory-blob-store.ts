import { createHash } from "node:crypto";
import type { BlobStore } from "@flowlathe/core";

export class InMemoryBlobStore implements BlobStore {
  private readonly bytesBySha = new Map<string, Buffer>();

  put(bytes: Buffer): string {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    this.bytesBySha.set(sha256, bytes);
    return sha256;
  }

  get(sha256: string): Buffer | undefined {
    return this.bytesBySha.get(sha256);
  }
}
