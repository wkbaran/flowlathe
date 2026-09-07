import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { putBlob } from "./blobs.js";
import type { Db } from "./db.js";
import { branches, executions, flowVersions, responses, runEvents, steps } from "./schema.js";

export interface StartedExecution {
  executionId: string;
  branchId: string;
}

export function startExecution(db: Db, flowVersionId: string, mode: "run" | "step" = "run"): StartedExecution {
  const executionId = randomUUID();
  const branchId = randomUUID();
  db.insert(executions)
    .values({ id: executionId, flowVersionId, status: "running", mode, rootBranchId: branchId })
    .run();
  db.insert(branches).values({ id: branchId, executionId, parentBranchId: null }).run();
  return { executionId, branchId };
}

export function setExecutionStatus(db: Db, executionId: string, status: "running" | "awaiting_input"): void {
  db.update(executions).set({ status }).where(eq(executions.id, executionId)).run();
}

export function finishExecution(
  db: Db,
  executionId: string,
  status: "finished" | "failed",
  errorJson?: unknown,
): void {
  db.update(executions)
    .set({
      status,
      endedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      errorJson: errorJson ?? null,
    })
    .where(eq(executions.id, executionId))
    .run();
}

export function beginStep(
  db: Db,
  input: { branchId: string; nodeId: string },
): string {
  const stepId = randomUUID();
  const latest = db
    .select({ stepIndex: steps.stepIndex })
    .from(steps)
    .where(eq(steps.branchId, input.branchId))
    .orderBy(desc(steps.stepIndex))
    .get();
  const stepIndex = (latest?.stepIndex ?? -1) + 1;
  db.insert(steps)
    .values({
      id: stepId,
      branchId: input.branchId,
      stepIndex,
      activationKey: input.nodeId,
      nodeId: input.nodeId,
      scopeJson: [],
      status: "running",
      startedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    })
    .run();
  return stepId;
}

export function finishStep(db: Db, stepId: string, status: "done" | "failed" | "skipped" | "cancelled"): void {
  db.update(steps)
    .set({ status, endedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
    .where(eq(steps.id, stepId))
    .run();
}

export interface ResponseRecord {
  executionId: string;
  branchId: string;
  stepId: string;
  nodeId: string;
  renderedPrompt: string;
  content: string;
  finishReason: string;
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  latencyMs: number;
}

export function recordResponse(db: Db, r: ResponseRecord): string {
  const id = randomUUID();
  const renderedPromptSha = putBlob(db, Buffer.from(r.renderedPrompt, "utf-8"));
  const contentSha = putBlob(db, Buffer.from(r.content, "utf-8"));
  db.insert(responses)
    .values({
      id,
      executionId: r.executionId,
      branchId: r.branchId,
      stepId: r.stepId,
      nodeId: r.nodeId,
      renderedPromptSha,
      contentSha,
      finishReason: r.finishReason,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      latencyMs: r.latencyMs,
    })
    .run();
  return id;
}

export function recordFailedResponse(
  db: Db,
  r: { executionId: string; branchId: string; stepId: string; nodeId: string; error: string },
): void {
  db.insert(responses)
    .values({
      id: randomUUID(),
      executionId: r.executionId,
      branchId: r.branchId,
      stepId: r.stepId,
      nodeId: r.nodeId,
      errorJson: { message: r.error },
    })
    .run();
}

export function appendRunEvent(
  db: Db,
  entry: { executionId: string; branchId: string | null; kind: string; payload: unknown },
): number {
  const row = db
    .select({ maxSeq: sql<number>`coalesce(max(${runEvents.seq}), 0)` })
    .from(runEvents)
    .where(eq(runEvents.executionId, entry.executionId))
    .get();
  const seq = (row?.maxSeq ?? 0) + 1;
  db.insert(runEvents)
    .values({
      id: randomUUID(),
      executionId: entry.executionId,
      branchId: entry.branchId,
      seq,
      kind: entry.kind,
      payloadJson: entry.payload,
    })
    .run();
  return seq;
}

export interface RunEventRow {
  seq: number;
  kind: string;
  payload: unknown;
}

export function listRunEventsSince(db: Db, executionId: string, afterSeq: number): RunEventRow[] {
  return db
    .select({ seq: runEvents.seq, kind: runEvents.kind, payload: runEvents.payloadJson })
    .from(runEvents)
    .where(and(eq(runEvents.executionId, executionId), gt(runEvents.seq, afterSeq)))
    .orderBy(asc(runEvents.seq))
    .all();
}

export interface ExecutionRow {
  id: string;
  flowVersionId: string;
  status: string;
  mode: string;
  startedAt: string;
  endedAt: string | null;
  errorJson: unknown;
}

export function getExecution(db: Db, executionId: string): ExecutionRow | undefined {
  return db.select().from(executions).where(eq(executions.id, executionId)).get();
}

/** This flow's executions, newest first — the seed `execution-gc.ts`'s `gcExecutions` iterates,
 *  via a join through `flow_versions` (an execution has no direct `flow_id` column). Exported
 *  rather than kept private: the natural seed for a future execution-history view too. */
export function listExecutionsForFlow(db: Db, flowId: string): ExecutionRow[] {
  return db
    .select({
      id: executions.id,
      flowVersionId: executions.flowVersionId,
      status: executions.status,
      mode: executions.mode,
      startedAt: executions.startedAt,
      endedAt: executions.endedAt,
      errorJson: executions.errorJson,
    })
    .from(executions)
    .innerJoin(flowVersions, eq(executions.flowVersionId, flowVersions.id))
    .where(eq(flowVersions.flowId, flowId))
    .orderBy(desc(executions.startedAt))
    .all();
}

/** The flow a given execution belongs to, via `executions.flowVersionId -> flow_versions.flowId`
 *  — an execution has no direct `flow_id` column of its own. */
export function flowIdForExecution(db: Db, executionId: string): string | undefined {
  const row = db
    .select({ flowId: flowVersions.flowId })
    .from(executions)
    .innerJoin(flowVersions, eq(executions.flowVersionId, flowVersions.id))
    .where(eq(executions.id, executionId))
    .get();
  return row?.flowId;
}

export interface ResponseLogRow {
  id: string;
  stepId: string | null;
  nodeId: string;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number | null;
  createdAt: string;
  renderedPromptSha: string | null;
  contentSha: string | null;
  errorJson: unknown;
}

export function listResponses(db: Db, executionId: string, branchId?: string): ResponseLogRow[] {
  const where = branchId
    ? and(eq(responses.executionId, executionId), eq(responses.branchId, branchId))
    : eq(responses.executionId, executionId);
  return db
    .select({
      id: responses.id,
      stepId: responses.stepId,
      nodeId: responses.nodeId,
      finishReason: responses.finishReason,
      promptTokens: responses.promptTokens,
      completionTokens: responses.completionTokens,
      latencyMs: responses.latencyMs,
      createdAt: responses.createdAt,
      renderedPromptSha: responses.renderedPromptSha,
      contentSha: responses.contentSha,
      errorJson: responses.errorJson,
    })
    .from(responses)
    .where(where)
    .orderBy(asc(responses.createdAt))
    .all();
}
