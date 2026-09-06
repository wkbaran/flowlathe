import { randomUUID } from "node:crypto";
import type { ContextMessage } from "@flowlathe/core";
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

export interface RecordContextTransformInput {
  executionId: string;
  transformKind: string;
  sourceMessages: ContextMessage[];
  resultMessages: ContextMessage[];
  providerId?: string | undefined;
  modelId?: string | undefined;
}

export interface RecordedContextTransform {
  sourceContextId: string;
  resultContextId: string;
  transformCallId: string;
}

/**
 * Persists one context-transform call as immutable version lineage: messages are content-
 * addressed (never duplicated), a context version is just an ordered list of message ids, and
 * `context_transform_calls` links source -> result so both the version tree and "which model
 * performed this compaction" are queryable. `models.id` (the FK column) is left null — like
 * `responses.model_id`, node data's `providerId`/`modelId` are adapter-facing strings, not rows
 * in the `models` catalog table; they're kept in `paramsJson` instead so nothing is lost.
 */
export function recordContextTransform(db: Db, input: RecordContextTransformInput): RecordedContextTransform {
  const sourceContextId = materializeContext(db, input.executionId, null, null, input.sourceMessages);
  const transformCallId = randomUUID();
  const resultContextId = materializeContext(db, input.executionId, sourceContextId, transformCallId, input.resultMessages);
  db.insert(contextTransformCalls)
    .values({
      id: transformCallId,
      sourceContextId,
      resultContextId,
      transformKind: input.transformKind,
      paramsJson: { providerId: input.providerId ?? null, modelId: input.modelId ?? null },
    })
    .run();
  return { sourceContextId, resultContextId, transformCallId };
}
