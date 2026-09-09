import { mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mintVersionedCopy, readStateFile, resolveWithinRoot, writeStateFile } from "./state-file-io.js";

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

describe("mintVersionedCopy", () => {
  it("seeds a new file from the template's content without mutating the template", () => {
    const templatePath = join(dir, "notes.md");
    writeFileSync(templatePath, "# seed content");
    const minted = mintVersionedCopy({ root: dir, flowVersion: 3 }, { path: templatePath });
    expect(minted.path).not.toBe(templatePath);
    expect(readFileSync(minted.path, "utf-8")).toBe("# seed content");
    expect(readFileSync(templatePath, "utf-8")).toBe("# seed content");
  });

  it("produces distinct paths for two mints in the same tick", () => {
    const templatePath = join(dir, "notes.md");
    writeFileSync(templatePath, "seed");
    const a = mintVersionedCopy({ root: dir, flowVersion: 1 }, { path: templatePath });
    const b = mintVersionedCopy({ root: dir, flowVersion: 1 }, { path: templatePath });
    expect(a.path).not.toBe(b.path);
  });
});

describe("readStateFile / writeStateFile", () => {
  it("round-trips UTF-8 content", () => {
    const path = join(dir, "f.txt");
    writeStateFile({ path }, "hello world", "replace", { maxBytes: 1000 });
    expect(readStateFile({ path }, { maxChars: 1000 })).toEqual({ content: "hello world", truncated: false });
  });

  it("refuses a file with a NUL byte as binary", () => {
    const path = join(dir, "bin.dat");
    writeFileSync(path, Buffer.from([0x61, 0x00, 0x62]));
    expect(() => readStateFile({ path }, { maxChars: 1000 })).toThrow(/binary/);
  });

  it("refuses a file with invalid UTF-8", () => {
    const path = join(dir, "bad.dat");
    writeFileSync(path, Buffer.from([0xff, 0xfe, 0xfd]));
    expect(() => readStateFile({ path }, { maxChars: 1000 })).toThrow(/UTF-8/);
  });

  it("truncates with a marker LAST, after scrubbing, not sliced off", () => {
    const path = join(dir, "big.txt");
    writeFileSync(path, "x".repeat(100));
    const result = readStateFile({ path }, { maxChars: 10 });
    expect(result.truncated).toBe(true);
    expect(result.content.endsWith("chars]")).toBe(true);
    expect(result.content.startsWith("x".repeat(10))).toBe(true);
  });

  it("scrubs hidden/zero-width characters", () => {
    const path = join(dir, "hidden.txt");
    writeFileSync(path, `a${"​"}b`);
    const result = readStateFile({ path }, { maxChars: 1000 });
    expect(result.content).toBe("ab");
  });

  it("append genuinely appends rather than overwriting", () => {
    const path = join(dir, "log.txt");
    writeStateFile({ path }, "one\n", "replace", { maxBytes: 1000 });
    writeStateFile({ path }, "two\n", "append", { maxBytes: 1000 });
    expect(readFileSync(path, "utf-8")).toBe("one\ntwo\n");
  });

  it("replace overwrites atomically, leaving no temp file behind", () => {
    const path = join(dir, "doc.txt");
    writeStateFile({ path }, "first", "replace", { maxBytes: 1000 });
    writeStateFile({ path }, "second", "replace", { maxBytes: 1000 });
    expect(readFileSync(path, "utf-8")).toBe("second");
    const leftover = readdirSync(dir).filter((f) => f.includes(".tmp"));
    expect(leftover).toEqual([]);
  });

  it("rejects a write over the byte cap", () => {
    const path = join(dir, "huge.txt");
    expect(() => writeStateFile({ path }, "x".repeat(100), "replace", { maxBytes: 10 })).toThrow(/exceeds/);
  });
});

afterEach(() => {
  // mkdtempSync directories are left on disk by design in this repo's other file-io test suites
  // (no explicit cleanup helper exists) — the OS temp dir is reclaimed by the environment.
  void dir;
});
