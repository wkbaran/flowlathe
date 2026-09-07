import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "./db.js";
import { executions, flowPins, flowVersions, stateDecls, triggers } from "./schema.js";

export interface FlowVersionGcOptions {
  /** Newest revisions (by version number, named or not) that are always kept regardless of age.
   *  Defaults to `FLOWLATHE_VERSION_GC_KEEP_NEWEST`, else 50. */
  keepNewest?: number;
  /** Only a revision older than this many days is even eligible. Defaults to
   *  `FLOWLATHE_VERSION_GC_OLDER_THAN_DAYS`, else 30. */
  olderThanDays?: number;
}

export interface FlowVersionGcResult {
  flowId: string;
  deleted: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Deletes unnamed (autosaved) revisions of one flow that are, ALL at once (PLAN-FLOW-VERSIONING.md
 * §4.3): (a) not the current HEAD, (b) not referenced by any execution, (c) not referenced by any
 * trigger or pin, (d) not among the newest `keepNewest` revisions, and (e) older than
 * `olderThanDays`. Every guard here protects a real data-loss path (§9 design trap 3) — a named
 * version is never even a candidate (`label !== null` is checked first and unconditionally skips
 * it, forever). `state_decls` rows are deleted alongside their `flow_versions` row since they FK to
 * it. Defaults are deliberately generous: disk is cheap, a lost revision is unrecoverable.
 */
export function gcFlowVersions(db: Db, flowId: string, opts: FlowVersionGcOptions = {}): FlowVersionGcResult {
  const keepNewest = opts.keepNewest ?? envInt("FLOWLATHE_VERSION_GC_KEEP_NEWEST", 50);
  const olderThanDays = opts.olderThanDays ?? envInt("FLOWLATHE_VERSION_GC_OLDER_THAN_DAYS", 30);
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

  const rows = db
    .select({ id: flowVersions.id, label: flowVersions.label, createdAt: flowVersions.createdAt })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId))
    .orderBy(desc(flowVersions.version))
    .all();
  if (rows.length === 0) return { flowId, deleted: 0 };

  const headId = rows[0]!.id;
  const protectedByRecency = new Set(rows.slice(0, keepNewest).map((r) => r.id));
  const ids = rows.map((r) => r.id);
  const referenced = new Set<string>([
    ...db.select({ id: executions.flowVersionId }).from(executions).where(inArray(executions.flowVersionId, ids)).all().map((r) => r.id),
    ...db.select({ id: triggers.flowVersionId }).from(triggers).where(inArray(triggers.flowVersionId, ids)).all().map((r) => r.id),
    ...db.select({ id: flowPins.flowVersionId }).from(flowPins).where(inArray(flowPins.flowVersionId, ids)).all().map((r) => r.id),
  ]);

  let deleted = 0;
  for (const row of rows) {
    if (row.id === headId) continue;
    if (row.label !== null) continue; // named — never collected
    if (referenced.has(row.id)) continue;
    if (protectedByRecency.has(row.id)) continue;
    if (row.createdAt > cutoff) continue; // not old enough yet
    db.delete(stateDecls).where(eq(stateDecls.flowVersionId, row.id)).run();
    db.delete(flowVersions).where(eq(flowVersions.id, row.id)).run();
    deleted++;
  }

  if (deleted > 0) {
    console.log(`[flow-version-gc] collected ${deleted} unnamed revision(s) of flow ${flowId}`);
  }
  return { flowId, deleted };
}
