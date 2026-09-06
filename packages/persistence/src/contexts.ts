import { randomUUID } from "node:crypto";
import type { CompactionMethod, ContextMessage } from "@flowlathe/core";
import { putBlob } from "./blobs.js";
import type { Db } from "./db.js";
import { contextMessages, contextTransformCalls, contexts, messages } from "./schema.js";

function materializeMessage(db: Db, m: ContextMessage): string {
  const contentSha = putBlob(db, Buffer.from(m.content, "utf-8"));
  const id = randomUUID();
  db.insert(messages).values({ id, role: m.role, contentSha }).run();
  return id;
}

function materializeContext(
  db: Db,
  executionId: string,
  parentContextId: string | null,
  transformCallId: string | null,
  msgs: ContextMessage[],
): string {
  const contextId = randomUUID();
  db.insert(contexts)
    .values({ id: contextId, executionId, parentContextId, transformCallId, messageCount: msgs.length })
    .run();
  msgs.forEach((m, ord) => {
    const messageId = materializeMessage(db, m);
    db.insert(contextMessages).values({ contextId, ord, messageId }).run();
  });
  return contextId;
}

export interface RecordContextCompactionInput {
  executionId: string;
  nodeId: string;
  method: CompactionMethod;
  sourceMessages: ContextMessage[];
  resultMessages: ContextMessage[];
}

export interface RecordedContextCompaction {
  sourceContextId: string;
  resultContextId: string;
  transformCallId: string;
}

/**
 * Persists one Gate-triggered compaction as immutable version lineage: messages are content-
 * addressed (never duplicated), a context version is just an ordered list of message ids, and
 * `context_transform_calls` links source -> result. Ordinary per-turn appends aren't persisted
 * here at all — that content already lives in `responses` (rendered prompt + output per call);
 * this table exists for the one operation that's actually lossy and worth auditing.
 */
export function recordContextCompaction(db: Db, input: RecordContextCompactionInput): RecordedContextCompaction {
  const sourceContextId = materializeContext(db, input.executionId, null, null, input.sourceMessages);
  const transformCallId = randomUUID();
  const resultContextId = materializeContext(db, input.executionId, sourceContextId, transformCallId, input.resultMessages);
  db.insert(contextTransformCalls)
    .values({
      id: transformCallId,
      sourceContextId,
      resultContextId,
      transformKind: input.method,
      paramsJson: { nodeId: input.nodeId },
    })
    .run();
  return { sourceContextId, resultContextId, transformCallId };
}
