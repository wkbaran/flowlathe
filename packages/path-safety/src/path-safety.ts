import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Path containment (PLAN-STATE-FILES.md / PLAN-GIT.md). `resolveWithinRoot` is
 * PLAN-FILE-TOOL.md's §5.1 primitive, originally ported into `@flowlathe/runtime`'s
 * `state-file-io.ts` and extracted here (PLAN-GIT.md §4.1) so `@flowlathe/plugin-common` can
 * depend on it without depending on all of `@flowlathe/runtime`'s much heavier transitive
 * closure (every node kind). This package has zero dependencies and is Node-only (`node:fs`/
 * `node:path`) — it cannot live in `@flowlathe/core`, which must stay isomorphic.
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
export function resolveWithinRoot(root: string, relativePath: string, opts?: { mustExist?: boolean }): PathVerdict {
  if (relativePath.includes("\0")) {
    return { ok: false, reason: "Blocked: path contains a NUL byte" };
  }
  if (isAbsolute(relativePath) || relativePath.startsWith("~")) {
    return { ok: false, reason: `Blocked: path "${relativePath}" must be relative to the configured root, not absolute` };
  }
  const normalized = relativePath.split(/[/\\]/);
  if (normalized.includes("..")) {
    return { ok: false, reason: `Blocked: path "${relativePath}" contains a ".." component` };
  }

  const candidate = resolve(root, relativePath);
  const mustExist = opts?.mustExist ?? false;

  let resolvedPath: string;
  if (existsSync(candidate)) {
    resolvedPath = realpathSync(candidate);
  } else {
    if (mustExist) {
      return { ok: false, reason: `Blocked: path "${relativePath}" does not exist` };
    }
    const ancestor = nearestExistingAncestor(candidate);
    if (!ancestor) {
      return { ok: false, reason: `Blocked: no existing ancestor directory for path "${relativePath}"` };
    }
    const realAncestor = realpathSync(ancestor.path);
    resolvedPath = join(realAncestor, ancestor.tail);
  }

  if (resolvedPath !== root && !resolvedPath.startsWith(root + sep)) {
    return { ok: false, reason: `Blocked: path "${relativePath}" resolves outside the configured root` };
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

/** `absolute` must already be contained in `root` (e.g. the `path` of a `resolveWithinRoot`
 *  success verdict) — returns the repo/root-relative form, e.g. for a git pathspec after `--`. */
export function relativeTo(root: string, absolute: string): string {
  return relative(root, absolute);
}
