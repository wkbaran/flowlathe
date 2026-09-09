import { randomBytes } from "node:crypto";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { scrubUntrustedText } from "@flowlathe/core";

/**
 * File-backed State I/O (PLAN-STATE-FILES.md). The path-containment primitive
 * (`resolveWithinRoot`) that used to live in this file was extracted into
 * `@flowlathe/path-safety` (PLAN-GIT.md §4.1) so `@flowlathe/plugin-common` could depend on it
 * without depending on all of `@flowlathe/runtime` — see that package for `resolveWithinRoot`/
 * `PathVerdict`. `@flowlathe/runtime` is Node-only (it already uses `node:crypto` in
 * `memory-blob-store.ts`), so `node:fs`/`node:path` here is fine — the isomorphism rule is scoped
 * to `@flowlathe/core`.
 */

export interface StateFileConfig {
  /** realpath'd at boot, verified directory. */
  root: string;
  /** `flow_versions.version` — for minting versioned filenames. */
  flowVersion: number;
}

export interface ResolvedStateFile {
  /** absolute, realpath'd, contained in root. */
  path: string;
}

/**
 * Mints "<dir>/<basename>.v<flowVersion>.<isoTimestamp>-<rand>.<ext>" next to the template
 * document, seeded with the template's current content. Called at most once per execution per
 * entry — the caller (`state-store.ts`) remembers the minted path for the rest of that execution.
 * A short random suffix (not just the ISO timestamp) avoids a collision between two calls in the
 * same millisecond.
 */
export function mintVersionedCopy(cfg: StateFileConfig, templatePath: ResolvedStateFile): ResolvedStateFile {
  const dir = dirname(templatePath.path);
  const base = basenameNoExt(templatePath.path);
  const ext = extOf(templatePath.path);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = randomBytes(4).toString("hex");
  const mintedPath = join(dir, `${base}.v${cfg.flowVersion}.${stamp}-${rand}${ext}`);
  const content = readFileSync(templatePath.path);
  writeFileSync(mintedPath, content, { mode: 0o644 });
  return { path: mintedPath };
}

function basenameNoExt(path: string): string {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf(sep) + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

export interface ReadStateFileResult {
  content: string;
  truncated: boolean;
}

/**
 * Reads a state-backed file, refusing binary content (a NUL byte in the first 8 KB, or a failed
 * strict UTF-8 decode) rather than dumping it into a prompt. Scrub-then-truncate, never
 * `sanitizeUntrustedText(text, maxLength)` — this function owns its own truncation marker, which
 * that call would slice back off.
 */
export function readStateFile(file: ResolvedStateFile, opts: { maxChars: number }): ReadStateFileResult {
  const bytes = readFileSync(file.path);
  const head = bytes.subarray(0, 8192);
  if (head.includes(0)) {
    throw new Error(`state file "${file.path}" appears to be binary (NUL byte found) — refusing to read it as text`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`state file "${file.path}" is not valid UTF-8 — refusing to read it as text`);
  }

  const scrubbed = scrubUntrustedText(text, "state file");
  if (scrubbed.length <= opts.maxChars) {
    return { content: scrubbed, truncated: false };
  }
  const sliced = scrubbed.slice(0, opts.maxChars);
  return { content: `${sliced}\n[truncated ${opts.maxChars} of ${scrubbed.length} chars]`, truncated: true };
}

export type FileWriteMode = "replace" | "append";

/**
 * `"replace"` writes atomically (temp file in the same directory, then `rename` — atomic on
 * POSIX within one directory). `"append"` cannot be made atomic the same way — a plain
 * append-mode write is used instead.
 */
export function writeStateFile(file: ResolvedStateFile, content: string, mode: FileWriteMode, opts: { maxBytes: number }): void {
  const byteLength = Buffer.byteLength(content, "utf-8");
  if (byteLength > opts.maxBytes) {
    throw new Error(`state file write of ${byteLength} bytes exceeds the ${opts.maxBytes}-byte limit`);
  }

  if (mode === "append") {
    appendFileSync(file.path, content, { mode: 0o644 });
    return;
  }

  const dir = dirname(file.path);
  const tmpPath = join(dir, `.flowlathe-state-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmpPath, content, { mode: 0o644 });
    renameSync(tmpPath, file.path);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
}

/** Verified directory, realpath'd — used for boot-time resolution of `FLOWLATHE_STATE_FILES_ROOT`. */
export function resolveStateFilesRoot(rawRoot: string): string {
  mkdirSync(rawRoot, { recursive: true });
  const real = realpathSync(rawRoot);
  if (!lstatSync(real).isDirectory()) {
    throw new Error(`FLOWLATHE_STATE_FILES_ROOT "${rawRoot}" is not a directory`);
  }
  return real;
}
