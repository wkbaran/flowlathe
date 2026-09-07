import { existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { uniqueSlug, type FlowGraph } from "@flowlathe/core";
import { DslError, format, parse, print } from "@flowlathe/dsl";
import {
  createFlow,
  getFlow,
  getFlowVersionRow,
  getLatestGraphForFlowVersion,
  listFlows,
  renameFlow,
  saveFlowVersion,
  type Db,
} from "@flowlathe/persistence";

const FLOW_EXT = ".flow";
const DEBOUNCE_MS = 300;

/** PLAN-FLOW-DSL.md §4.1: default `./flows`, overridable via `FLOWLATHE_FLOWS_DIR`. */
export function flowsDir(): string {
  return process.env["FLOWLATHE_FLOWS_DIR"] ?? "./flows";
}

function slugFromFilename(filename: string): string | undefined {
  return filename.endsWith(FLOW_EXT) ? filename.slice(0, -FLOW_EXT.length) : undefined;
}

export function canonicalTextFor(name: string, graph: FlowGraph): string {
  return print({ name, graph, comments: {} });
}

export interface LoadedFlowFile {
  name: string;
  graph: FlowGraph;
  /** Canonical (formatted) text — not necessarily byte-identical to what's on disk, so an
   *  editor's formatting-only edit still hashes/dedups the same as before it. */
  sourceText: string;
}

export function loadFlowFile(dir: string, slug: string): LoadedFlowFile | undefined {
  const path = join(dir, `${slug}${FLOW_EXT}`);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  const { name, graph } = parse(raw);
  return { name, graph, sourceText: format(raw) };
}

export interface SyncOutcome {
  slug: string;
  /** A new `flow_versions` row was written (or the flow itself was newly created). False when
   *  the file's canonical text matched the already-stored `content_hash` exactly. */
  changed: boolean;
  error?: string;
}

/** Reads `<dir>/<slug>.flow`, and makes the DB agree with it: creates the `flows` row (id =
 *  `slug`) if it doesn't exist yet, renames it if the file's `flow "..."` header changed, and
 *  snapshots a new `flow_versions` row unless the canonical text is byte-identical to the
 *  current one (content-hash dedup, `saveFlowVersion`). A malformed file is reported, not
 *  thrown — one bad file shouldn't take down a boot-time sync of every other flow. */
export function syncFlowFile(db: Db, dir: string, slug: string): SyncOutcome {
  let loaded: LoadedFlowFile | undefined;
  try {
    loaded = loadFlowFile(dir, slug);
  } catch (err) {
    const message = err instanceof DslError ? err.message : (err as Error).message;
    return { slug, changed: false, error: message };
  }
  if (!loaded) return { slug, changed: false, error: `${slug}${FLOW_EXT} not found` };

  const { name, graph, sourceText } = loaded;
  const existing = getFlow(db, slug);
  if (!existing) {
    createFlow(db, name, graph, { id: slug, sourceText });
    return { slug, changed: true };
  }
  if (existing.name !== name) renameFlow(db, slug, name);
  const saved = saveFlowVersion(db, slug, graph, sourceText);
  return { slug, changed: saved.flowVersionId !== existing.flowVersionId };
}

/** `getLatestGraphForFlowVersion`'s file-aware wrapper (§4.2): resolves the version's owning
 *  flow, then prefers the CURRENT on-disk file over the DB's latest row — so "step back, edit
 *  the file, step forward" picks up the edit even before the watcher's debounce has synced it
 *  to the DB. Falls back to the DB's latest row when the file is gone, so a deleted flow's
 *  execution still resolves a graph to step through. */
export function getLatestGraphForFlowVersionFileAware(db: Db, dir: string, flowVersionId: string): FlowGraph | undefined {
  const row = getFlowVersionRow(db, flowVersionId);
  if (!row) return undefined;
  try {
    const loaded = loadFlowFile(dir, row.flowId);
    if (loaded) return loaded.graph;
  } catch {
    // Mid-edit / momentarily invalid file (e.g. an editor's atomic-rename write caught between
    // steps) — fall back to the DB's latest row rather than fail the step outright.
  }
  return getLatestGraphForFlowVersion(db, flowVersionId);
}

export function syncAllFlowFiles(db: Db, dir: string): SyncOutcome[] {
  if (!existsSync(dir)) return [];
  const slugs = readdirSync(dir).map(slugFromFilename).filter((s): s is string => s !== undefined);
  return slugs.map((slug) => syncFlowFile(db, dir, slug));
}

function isSlugLike(id: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id);
}

/** Every flow in the DB -> `<dir>/<slug>.flow`. Used both by `flowlathe flows export` and by
 *  `autoExportIfEmpty` below. A flow whose id already looks like a slug (every flow created
 *  since S3, since `createFlow` now derives one from the name — see `persistence/flows.ts`)
 *  keeps that id as its filename, so a later `syncAllFlowFiles` resolves back to the SAME flow
 *  row rather than minting a duplicate. A flow with a pre-S3 UUID id has no such option — it
 *  gets a fresh slug derived from its name instead, and stays a permanently separate row from
 *  whatever `syncAllFlowFiles` later creates for that filename. That's a real, known migration
 *  gap (PLAN-FLOW-DSL.md doesn't specify a reconciliation algorithm for it): after migrating an
 *  existing DB-backed install, the old UUID-id flow and the new slug-id flow both exist until an
 *  operator deletes the old one by hand. */
export function exportAllFlowsToDir(db: Db, dir: string): void {
  mkdirSync(dir, { recursive: true });
  const taken = new Set<string>();
  for (const summary of listFlows(db)) {
    const flow = getFlow(db, summary.id);
    if (!flow) continue;
    const slug = isSlugLike(flow.id) ? uniqueSlug(flow.id, taken) : uniqueSlug(flow.name, taken);
    taken.add(slug);
    writeFileSync(join(dir, `${slug}${FLOW_EXT}`), canonicalTextFor(flow.name, flow.graph));
  }
}

/** PLAN-FLOW-DSL.md §4.4: "Export runs automatically once at boot if FLOWLATHE_FLOWS_DIR is
 *  empty and the DB has flows." Returns whether it actually exported anything. */
export function autoExportIfEmpty(db: Db, dir: string): boolean {
  const hasFlowFiles = existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(FLOW_EXT));
  if (hasFlowFiles) return false;
  const flows = listFlows(db);
  if (flows.length === 0) return false;
  exportAllFlowsToDir(db, dir);
  console.log(`[flow-store] auto-exported ${flows.length} flow(s) to ${dir}`);
  return true;
}

/**
 * `fs.watch` with a per-file debounce, not chokidar — PLAN-FLOW-DSL.md §8 design trap 4 flags
 * `fs.watch` as unreliable on WSL2 specifically for editors that write via rename, and this is
 * the target machine; that could not be verified against a real editor inside this sandbox (no
 * interactive editor session available here), so it's recorded as an open risk rather than
 * silently assumed fine — see CLAUDE.md. Swapping to chokidar later is a one-function change:
 * everything else here only depends on "call `onChange(slug)` when a `.flow` file settles."
 */
export function watchFlowsDir(dir: string, onChange: (slug: string) => void): () => void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, (_eventType, filename) => {
      const slug = filename ? slugFromFilename(filename) : undefined;
      if (!slug) return;
      const existingTimer = timers.get(slug);
      if (existingTimer) clearTimeout(existingTimer);
      timers.set(
        slug,
        setTimeout(() => {
          timers.delete(slug);
          onChange(slug);
        }, DEBOUNCE_MS),
      );
    });
  } catch (err) {
    console.error(`[flow-store] could not watch ${dir}: ${(err as Error).message}`);
    return () => {};
  }
  return () => {
    watcher.close();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
