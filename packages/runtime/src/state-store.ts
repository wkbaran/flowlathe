import { applyMerge, scrubUntrustedText, type MergeRule, type RunEvent, type StateDecl, type StateStore } from "@flowlathe/core";
import {
  mintVersionedCopy,
  readStateFile,
  resolveWithinRoot,
  writeStateFile,
  type ResolvedStateFile,
  type StateFileConfig,
} from "./state-file-io.js";

/** Same discipline as `PLAN-TOOL-APPROVAL.md`'s `argsPreview`: a `state_write` event for a
 *  file-type entry carries a bounded preview, not the full file content — a growing markdown
 *  document embedded in full on every write would bloat the persisted run-event log and the live
 *  SSE stream without bound. Scrub-then-truncate (never `sanitizeUntrustedText(text, maxLength)`)
 *  so the truncation marker survives. */
const STATE_FILE_WRITE_PREVIEW_MAX_CHARS = 4000;
const STATE_FILE_READ_MAX_CHARS = 20_000;
const STATE_FILE_WRITE_MAX_BYTES = 1_000_000;

function previewOf(text: string): string {
  const scrubbed = scrubUntrustedText(text, "state file write");
  if (scrubbed.length <= STATE_FILE_WRITE_PREVIEW_MAX_CHARS) return scrubbed;
  return `${scrubbed.slice(0, STATE_FILE_WRITE_PREVIEW_MAX_CHARS)}\n[truncated ${STATE_FILE_WRITE_PREVIEW_MAX_CHARS} of ${scrubbed.length} chars]`;
}

export interface StateStoreInit {
  decls: StateDecl[];
  /** Past writes to fold in before this store is used — how a step-mode host resumes a branch's
   *  state across `stepOnce` calls (each of which builds a fresh host). A step-back fork's own
   *  writes already include its pre-fork inheritance, seeded once at fork time by `stepBack`
   *  (see `getStateSnapshotAsOf`) — this replay itself only ever looks at one branch's rows. */
  replay?: { entry: string; value: unknown; seq: number }[] | undefined;
  /** Required when `decls` contains at least one `type: "file"` entry — absent otherwise. */
  fileConfig?: StateFileConfig | undefined;
}

export function createStateStore(emit: (event: RunEvent) => void, init: StateStoreInit): StateStore {
  const values = new Map<string, unknown>();
  const rules = new Map<string, MergeRule>();
  const fileDecls = new Map(init.decls.filter((d) => d.type === "file").map((d) => [d.name, d]));
  // Lazily minted, per-store-instance (i.e. per execution/per stepOnce call) — a versioned
  // entry's resolved path is remembered so every access within the same instance reuses it.
  const resolvedPaths = new Map<string, ResolvedStateFile>();

  for (const decl of init.decls ?? []) {
    rules.set(decl.name, decl.merge);
    if (decl.initial !== undefined) values.set(decl.name, decl.initial);
  }
  let seq = 0;
  for (const write of init.replay ?? []) {
    values.set(write.entry, write.value);
    seq = Math.max(seq, write.seq);
  }

  if (fileDecls.size > 0 && !init.fileConfig) {
    throw new Error(
      `this flow declares a file-backed state entry but FLOWLATHE_STATE_FILES_ROOT is not configured on this server`,
    );
  }

  function resolveFor(decl: StateDecl): ResolvedStateFile {
    const cfg = init.fileConfig!;
    // Read-only entries and versioned entries' seed documents must already exist; a non-versioned
    // read-write entry's first write is allowed to create it.
    const mustExist = decl.fileMode === "read-only" || decl.versioned === true;
    const verdict = resolveWithinRoot(cfg.root, decl.filePath!, { mustExist });
    if (!verdict.ok) throw new Error(`state entry "${decl.name}": ${verdict.reason}`);
    const template: ResolvedStateFile = { path: verdict.path! };
    if (decl.fileMode === "read-only" || !decl.versioned) return template;
    const cached = resolvedPaths.get(decl.name);
    if (cached) return cached;
    const minted = mintVersionedCopy(cfg, template);
    resolvedPaths.set(decl.name, minted);
    return minted;
  }

  return {
    read(entry, meta) {
      const decl = fileDecls.get(entry);
      if (decl) {
        const { content } = readStateFile(resolveFor(decl), { maxChars: STATE_FILE_READ_MAX_CHARS });
        emit({ kind: "state_read", entry, seqSeen: seq, viaTool: meta?.viaTool ?? false, activationKey: meta?.activationKey });
        return content;
      }
      const value = values.get(entry);
      emit({ kind: "state_read", entry, seqSeen: seq, viaTool: meta?.viaTool ?? false, activationKey: meta?.activationKey });
      return value;
    },
    write(entry, value, meta) {
      const decl = fileDecls.get(entry);
      if (decl) {
        if (decl.fileMode === "read-only") {
          throw new Error(`state entry "${entry}" is read-only — write_state cannot modify it`);
        }
        const mode = decl.merge === "append" ? "append" : "replace";
        writeStateFile(resolveFor(decl), String(value), mode, { maxBytes: STATE_FILE_WRITE_MAX_BYTES });
        seq += 1;
        emit({
          kind: "state_write",
          entry,
          value: previewOf(String(value)),
          merge: decl.merge,
          seq,
          viaTool: meta?.viaTool ?? false,
          activationKey: meta?.activationKey,
        });
        return;
      }

      const rule = rules.get(entry);
      if (!rule) throw new Error(`unknown state entry "${entry}" — declare it in the flow's State panel first`);
      seq += 1;
      const merged = applyMerge(rule, values.get(entry), value, entry);
      values.set(entry, merged);
      emit({
        kind: "state_write",
        entry,
        value: merged,
        merge: rule,
        seq,
        viaTool: meta?.viaTool ?? false,
        activationKey: meta?.activationKey,
      });
    },
  };
}
