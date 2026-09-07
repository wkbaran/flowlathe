import { eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { getFlowVersionRow, type FlowVersionRow } from "./flows.js";
import { executions, flowVersions } from "./schema.js";

export interface FlowVersionSummary {
  id: string;
  version: number;
  label: string | null;
  message: string | null;
  contentHash: string | null;
  parentVersionId: string | null;
  createdAt: string;
  isHead: boolean;
  executionCount: number;
}

/** Newest first — what the version-history drawer renders (PLAN-FLOW-VERSIONING.md §4.5). */
export function listFlowVersions(db: Db, flowId: string): FlowVersionSummary[] {
  const rows = db
    .select({
      id: flowVersions.id,
      version: flowVersions.version,
      label: flowVersions.label,
      message: flowVersions.message,
      contentHash: flowVersions.contentHash,
      parentVersionId: flowVersions.parentVersionId,
      createdAt: flowVersions.createdAt,
    })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId))
    .orderBy(sql`${flowVersions.version} DESC`)
    .all();
  if (rows.length === 0) return [];

  const headVersion = rows[0]!.version;
  const counts = db
    .select({ flowVersionId: executions.flowVersionId, count: sql<number>`count(*)` })
    .from(executions)
    .where(
      inArray(
        executions.flowVersionId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(executions.flowVersionId)
    .all();
  const countByVersionId = new Map(counts.map((c) => [c.flowVersionId, c.count]));

  return rows.map((r) => ({
    ...r,
    isHead: r.version === headVersion,
    executionCount: countByVersionId.get(r.id) ?? 0,
  }));
}

/** Names an existing revision without creating a new row — for labeling any past revision
 *  directly (not just the one `saveFlowVersion`'s dedup path happens to land on). `message`
 *  omitted leaves the existing message untouched. */
export function labelFlowVersion(db: Db, flowVersionId: string, label: string, message?: string): FlowVersionRow | undefined {
  const existing = getFlowVersionRow(db, flowVersionId);
  if (!existing) return undefined;
  db.update(flowVersions)
    .set({ label, message: message !== undefined ? message : existing.message })
    .where(eq(flowVersions.id, flowVersionId))
    .run();
  return getFlowVersionRow(db, flowVersionId);
}
