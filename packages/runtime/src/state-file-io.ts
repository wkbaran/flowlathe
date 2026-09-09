import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { scrubUntrustedText } from "@flowlathe/core";

/**
 * File-backed State I/O (PLAN-STATE-FILES.md). `resolveWithinRoot` is PLAN-FILE-TOOL.md's §5.1
 * primitive, ported verbatim and relocated here — this design has no separate `fs` toolset for it
 * to belong to (see CLAUDE.md). `@flowlathe/runtime` is Node-only (it already uses `node:crypto`
 * in `memory-blob-store.ts`), so `node:fs`/`node:path` here is fine — the isomorphism rule is
 * scoped to `@flowlathe/core`.
 */

export interface PathVerdict {
  ok: boolean;
  /** Present when !ok. Always starts with "Blocked:". */
  reason?: string;
  /** Present when ok — the realpath-resolved absolute path. Use this, never the input. */
  path?: string;
}

/**
 * Resolve a caller-supplied relative path under `root`, or refuse. `root` must already be
 * realpath'd by the caller (done once at boot).
 *
 * Checks, in order:
 * 1. NUL byte anywhere.
 * 2. Absolute path or `~` prefix.
 * 3. A lexical `..` component.
 * 4. `path.resolve(root, relative)`.
 * 5. `realpathSync` on the candidate (or its nearest existing ancestor, when `mustExist` is
 *    false) — this is what closes a symlink escape.
 * 6. Containment: the resolved path must equal `root` or start with `root + path.sep` — compared
 *    on resolved strings, never the raw input (the `+ sep` is what makes `/root-evil` not match
 *    `/root`).
 *
 * Known accepted gap — TOCTOU: between step 5 and the eventual read/write, a symlink could be
 * swapped. Closing it needs `open` with `O_NOFOLLOW` on every path component, which Node doesn't
 * expose usefully. The attacker must already have write access to a directory inside the root on
 * a single-user local server — considered and declined, not overlooked (mirrors `url-safety.ts`'s
 * DNS-rebinding note).
 */
export function resolveWithinRoot(root: string, relative: string, opts?: { mustExist?: boolean }): PathVerdict {
  if (relative.includes("\0")) {
    return { ok: false, reason: "Blocked: path contains a NUL byte" };
  }
  if (isAbsolute(relative) || relative.startsWith("~")) {
    return { ok: false, reason: `Blocked: path "${relative}" must be relative to the configured root, not absolute` };
  }
  const normalized = relative.split(/[/\\]/);
  if (normalized.includes("..")) {
    return { ok: false, reason: `Blocked: path "${relative}" contains a ".." component` };
  }

  const candidate = resolve(root, relative);
  const mustExist = opts?.mustExist ?? false;

  let resolvedPath: string;
  if (existsSync(candidate)) {
    resolvedPath = realpathSync(candidate);
  } else {
    if (mustExist) {
      return { ok: false, reason: `Blocked: path "${relative}" does not exist` };
    }
    const ancestor = nearestExistingAncestor(candidate);
    if (!ancestor) {
      return { ok: false, reason: `Blocked: no existing ancestor directory for path "${relative}"` };
    }
    const realAncestor = realpathSync(ancestor.path);
    resolvedPath = join(realAncestor, ancestor.tail);
  }

  if (resolvedPath !== root && !resolvedPath.startsWith(root + sep)) {
    return { ok: false, reason: `Blocked: path "${relative}" resolves outside the configured root` };
  }

  return { ok: true, path: resolvedPath };
}

function nearestExistingAncestor(candidate: string): { path: string; tail: string } | undefined {
  let dir = candidate;
  const tailParts: string[] = [];
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return undefined; // hit the filesystem root without finding anything
    tailParts.unshift(basename(dir));
    dir = parent;
  }
  return { path: dir, tail: tailParts.join(sep) };
}

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
