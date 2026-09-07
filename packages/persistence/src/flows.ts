import { createHash, randomUUID } from "node:crypto";
import { canonicalGraphJson, uniqueSlug, type FlowGraph } from "@flowlathe/core";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "./db.js";
import { gcFlowVersions } from "./flow-version-gc.js";
import { flowVersions, flows } from "./schema.js";
import { saveStateDecls } from "./state.js";

export interface FlowSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowWithGraph extends FlowSummary {
  flowVersionId: string;
  version: number;
  graph: FlowGraph;
  /** This version's content hash — sha256 of `sourceText` when given, else of
   *  `canonicalGraphJson(graph)` (PLAN-FLOW-VERSIONING.md §4.1). The canvas sends this back as
   *  `PUT /api/flows/:id`'s `ifMatch` to detect a conflicting external edit; see routes/flows.ts.
   *  Only ever null for a row predating this dedup mechanism (PLAN-FLOW-DSL.md S3), before the
   *  one-time backfill (`backfillContentHashes`) runs. */
  contentHash: string | null;
}

export interface FlowVersionRow {
  id: string;
  flowId: string;
  version: number;
  graph: FlowGraph;
  /** Null for a version predating PLAN-FLOW-DSL.md S3, or one saved without DSL text. */
  sourceText: string | null;
  contentHash: string | null;
  /** Non-null exactly for a named version a human labeled (PLAN-FLOW-VERSIONING.md §3) — never
   *  garbage-collected. */
  label: string | null;
  message: string | null;
  /** The version this one was saved from — usually the prior version, but the restored-from
   *  version after a restore. Null for a flow's very first version. */
  parentVersionId: string | null;
  createdAt: string;
}

/** sha256 hex of a flow's canonical DSL text — the exact value stored in `content_hash` when
 *  `sourceText` is available. Exposed so a caller (the server's PUT route's `ifMatch` check) can
 *  compare against it without re-deriving the same hash a second way. */
export function contentHashOf(sourceText: string): string {
  return sha256Hex(sourceText);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

/** The hash `saveFlowVersion`/`createFlow` dedup against: `sourceText`'s hash when given (every
 *  real save path has DSL text now that flows are file-backed), else `canonicalGraphJson(graph)`'s
 *  — the fallback PLAN-FLOW-VERSIONING.md §4.1 calls for so a DB-only caller (no `.flow` file
 *  involved) still gets dedup instead of silently accumulating one row per identical save. */
function computeContentHash(graph: FlowGraph, sourceText: string | undefined): string {
  return sourceText !== undefined ? sha256Hex(sourceText) : sha256Hex(canonicalGraphJson(graph));
}

/** A flow's id defaults to a slugified, collision-suffixed form of its name — PLAN-FLOW-DSL.md
 *  §4.1: "the file's basename is the flow's stable identifier." Pass `opts.id` to pin an exact
 *  id instead (the file store uses this: the id IS the filename it's syncing). `opts.sourceText`
 *  fills in `content_hash` on this first version directly, so a caller that's about to write the
 *  corresponding `.flow` file too (every server-side creation path does) doesn't need a
 *  redundant immediate `saveFlowVersion` call just to attach it. */
export function createFlow(db: Db, name: string, graph: FlowGraph, opts?: { id?: string; sourceText?: string }): FlowWithGraph {
  const id = opts?.id ?? uniqueSlug(name, new Set(db.select({ id: flows.id }).from(flows).all().map((r) => r.id)));
  db.insert(flows).values({ id, name }).run();
  const version = 1;
  const flowVersionId = randomUUID();
  const sourceText = opts?.sourceText;
  const contentHash = computeContentHash(graph, sourceText);
  db.insert(flowVersions)
    .values({ id: flowVersionId, flowId: id, version, graphJson: graph, sourceText: sourceText ?? null, contentHash })
    .run();
  saveStateDecls(db, flowVersionId, graph.state);
  const row = mustGetFlowRow(db, id);
  return { ...row, flowVersionId, version, graph, contentHash };
}

export function listFlows(db: Db): FlowSummary[] {
  return db
    .select({ id: flows.id, name: flows.name, createdAt: flows.createdAt, updatedAt: flows.updatedAt })
    .from(flows)
    .orderBy(desc(flows.updatedAt))
    .all();
}

export function getFlow(db: Db, id: string): FlowWithGraph | undefined {
  const flow = db.select().from(flows).where(eq(flows.id, id)).get();
  if (!flow) return undefined;
  const latest = db
    .select()
    .from(flowVersions)
    .where(eq(flowVersions.flowId, id))
    .orderBy(desc(flowVersions.version))
    .get();
  if (!latest) return undefined;
  return { ...flow, flowVersionId: latest.id, version: latest.version, graph: latest.graphJson, contentHash: latest.contentHash };
}

/** Returns the *exact* pinned version's graph — never the flow's latest. A trigger runs a
 *  pinned `flowVersionId`, deliberately never HEAD (unlike step sessions, which resolve forward
 *  to the latest version via `getLatestGraphForFlowVersion` below): editing a flow on the canvas
 *  must not silently change what a live trigger does. */
export function getGraphForFlowVersion(db: Db, flowVersionId: string): FlowGraph | undefined {
  return db.select({ graph: flowVersions.graphJson }).from(flowVersions).where(eq(flowVersions.id, flowVersionId)).get()?.graph;
}

/** The full row behind one version id — including `sourceText`, so a viewer can render an
 *  execution's flow *as DSL text* even after the underlying flow was deleted or its file
 *  changed on disk (PLAN-FLOW-DSL.md's definition-of-done item for exactly this). */
export function getFlowVersionRow(db: Db, flowVersionId: string): FlowVersionRow | undefined {
  const row = db.select().from(flowVersions).where(eq(flowVersions.id, flowVersionId)).get();
  if (!row) return undefined;
  return {
    id: row.id,
    flowId: row.flowId,
    version: row.version,
    graph: row.graphJson,
    sourceText: row.sourceText,
    contentHash: row.contentHash,
    label: row.label,
    message: row.message,
    parentVersionId: row.parentVersionId,
    createdAt: row.createdAt,
  };
}

/** Resolves the flow owning `flowVersionId`, then returns that flow's CURRENT (latest-saved)
 *  graph. Step sessions bind to the version active at step-start, but the graph is a live
 *  editing surface — stepping forward should reflect edits made since. Once a flow is file-
 *  backed this is still correct: the file store snapshots a new `flow_versions` row on every
 *  on-disk change (via `saveFlowVersion`'s content-hash dedup below), so "latest row" and
 *  "current file" agree — the file-aware wrapper that prefers reading the file directly lives in
 *  `@flowlathe/server`'s flow-store (persistence stays DB-only, no file I/O — same isomorphism
 *  discipline CLAUDE.md documents for `@flowlathe/core`/`@flowlathe/dsl`). */
export function getLatestGraphForFlowVersion(db: Db, flowVersionId: string): FlowGraph | undefined {
  const version = db
    .select({ flowId: flowVersions.flowId })
    .from(flowVersions)
    .where(eq(flowVersions.id, flowVersionId))
    .get();
  if (!version) return undefined;
  const latest = db
    .select({ graph: flowVersions.graphJson })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, version.flowId))
    .orderBy(desc(flowVersions.version))
    .get();
  return latest?.graph;
}

export interface SaveFlowVersionOptions {
  /** Names this save as a milestone — never garbage-collected (PLAN-FLOW-VERSIONING.md §3). If a
   *  row with the same content hash already exists, it's labeled in place rather than duplicated. */
  label?: string;
  message?: string;
  /** The version this save was made *from*. Defaults to whatever was HEAD before this insert (the
   *  ordinary edit-and-save case). A restore passes the restored-from version explicitly here,
   *  since that's the real provenance even though it isn't the immediately preceding version —
   *  see the `parentVersionId` column doc in schema.ts. */
  parentVersionId?: string;
  /** Skip the dedup lookup and always insert a genuinely new row, even if its content duplicates
   *  an existing one. Restore's whole point is to make an old graph the new HEAD (§3: "Restore
   *  creates a new version") — ordinary dedup would instead just hand back the OLD row, which is
   *  not the new HEAD by version number, silently turning "restore" into a no-op. `content_hash`
   *  is deliberately not a DB-enforced UNIQUE constraint (see schema.ts) specifically so this can
   *  insert without violating it. */
  force?: boolean;
}

/**
 * Content-addressed: a row with the same (flowId, contentHash) already existing means this save
 * didn't actually change anything (only mtime did, say, or a debugging session ran the same graph
 * ten times), and no new version is written — PLAN-FLOW-VERSIONING.md §4.2's "saving an unchanged
 * graph creates no new row." `sourceText`, when given, is what's hashed (the exact DSL text a
 * `.flow` file holds); otherwise `canonicalGraphJson(graph)` is, so a DB-only caller still gets
 * real dedup rather than the old "always insert" behavior. Pass `opts.force` (restore) to bypass
 * this and always insert.
 */
export function saveFlowVersion(db: Db, flowId: string, graph: FlowGraph, sourceText?: string, opts: SaveFlowVersionOptions = {}): FlowWithGraph {
  const flow = db.select().from(flows).where(eq(flows.id, flowId)).get();
  if (!flow) throw new Error(`flow not found: ${flowId}`);

  const contentHash = computeContentHash(graph, sourceText);
  const existing = opts.force
    ? undefined
    : db
        .select()
        .from(flowVersions)
        .where(and(eq(flowVersions.flowId, flowId), eq(flowVersions.contentHash, contentHash)))
        .get();
  if (existing) {
    if (opts.label !== undefined) {
      db.update(flowVersions)
        .set({ label: opts.label, message: opts.message ?? existing.message })
        .where(eq(flowVersions.id, existing.id))
        .run();
    }
    return { ...flow, flowVersionId: existing.id, version: existing.version, graph: existing.graphJson, contentHash: existing.contentHash };
  }

  const latest = db
    .select({ id: flowVersions.id, version: flowVersions.version })
    .from(flowVersions)
    .where(eq(flowVersions.flowId, flowId))
    .orderBy(desc(flowVersions.version))
    .get();
  const version = (latest?.version ?? 0) + 1;
  const flowVersionId = randomUUID();
  db.insert(flowVersions)
    .values({
      id: flowVersionId,
      flowId,
      version,
      graphJson: graph,
      sourceText: sourceText ?? null,
      contentHash,
      label: opts.label ?? null,
      message: opts.message ?? null,
      parentVersionId: opts.parentVersionId ?? latest?.id ?? null,
    })
    .run();
  saveStateDecls(db, flowVersionId, graph.state);
  db.update(flows)
    .set({ updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
    .where(eq(flows.id, flowId))
    .run();
  // PLAN-FLOW-VERSIONING.md §4.3: run retention on every real save (a dedup hit above changed
  // nothing, so there's nothing new to reconsider) — cheap and bounded, so it never needs its own
  // cron job.
  gcFlowVersions(db, flowId);
  const row = mustGetFlowRow(db, flowId);
  return { ...row, flowVersionId, version, graph, contentHash };
}

/** Renames a flow's display name without touching its id/slug or creating a new version — the
 *  file store uses this when a `.flow` file's `flow "..."` header changes but the filename (the
 *  id) doesn't. */
export function renameFlow(db: Db, id: string, name: string): void {
  db.update(flows)
    .set({ name, updatedAt: sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))` })
    .where(eq(flows.id, id))
    .run();
}

function mustGetFlowRow(db: Db, id: string): FlowSummary {
  const row = db.select().from(flows).where(eq(flows.id, id)).get();
  if (!row) throw new Error(`flow not found: ${id}`);
  return row;
}
