import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { relativeTo, resolveWithinRoot } from "./path-safety.js";

let dir: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "flowlathe-state-files-")));
});

describe("resolveWithinRoot", () => {
  it("allows the root itself", () => {
    expect(resolveWithinRoot(dir, "").ok).toBe(true);
    expect(resolveWithinRoot(dir, ".").path).toBe(dir);
  });

  it("allows a plain relative file under the root", () => {
    writeFileSync(join(dir, "a.txt"), "hi");
    const verdict = resolveWithinRoot(dir, "a.txt");
    expect(verdict.ok).toBe(true);
    expect(verdict.path).toBe(join(dir, "a.txt"));
  });

  it("refuses a '..' component in the middle", () => {
    expect(resolveWithinRoot(dir, "a/../../etc/passwd").ok).toBe(false);
  });

  it("refuses a '..' component at the start", () => {
    expect(resolveWithinRoot(dir, "../outside").ok).toBe(false);
  });

  it("refuses an absolute path", () => {
    expect(resolveWithinRoot(dir, "/etc/passwd").ok).toBe(false);
  });

  it("refuses a ~-prefixed path", () => {
    expect(resolveWithinRoot(dir, "~/secrets").ok).toBe(false);
  });

  it("refuses a NUL byte", () => {
    expect(resolveWithinRoot(dir, "a\0b").ok).toBe(false);
  });

  it("refuses a symlink inside the root pointing outside it", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "flowlathe-outside-"));
    const target = join(outsideDir, "secret.txt");
    writeFileSync(target, "nope");
    symlinkSync(target, join(dir, "link.txt"));
    const verdict = resolveWithinRoot(dir, "link.txt", { mustExist: true });
    expect(verdict.ok).toBe(false);
  });

  it("allows a symlink inside the root pointing inside it, resolved to the real path", () => {
    writeFileSync(join(dir, "real.txt"), "yes");
    symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
    const verdict = resolveWithinRoot(dir, "link.txt", { mustExist: true });
    expect(verdict.ok).toBe(true);
    expect(verdict.path).toBe(join(dir, "real.txt"));
  });

  it("allows a not-yet-existing file whose parent exists", () => {
    const verdict = resolveWithinRoot(dir, "new-file.txt", { mustExist: false });
    expect(verdict.ok).toBe(true);
    expect(verdict.path).toBe(join(dir, "new-file.txt"));
  });

  it("refuses a not-yet-existing file when mustExist is true", () => {
    expect(resolveWithinRoot(dir, "nope.txt", { mustExist: true }).ok).toBe(false);
  });

  it("refuses a not-yet-existing file whose parent is a symlink out of the root", () => {
    const outsideDir = mkdtempSync(join(tmpdir(), "flowlathe-outside2-"));
    symlinkSync(outsideDir, join(dir, "linkdir"));
    const verdict = resolveWithinRoot(dir, "linkdir/new.txt", { mustExist: false });
    expect(verdict.ok).toBe(false);
  });
});

describe("relativeTo", () => {
  it("returns a root-relative path for a contained absolute path", () => {
    expect(relativeTo(dir, join(dir, "src", "x.ts"))).toBe(join("src", "x.ts"));
  });

  it("returns an empty string for the root itself", () => {
    expect(relativeTo(dir, dir)).toBe("");
  });
});
