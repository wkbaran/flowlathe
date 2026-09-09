import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent } from "@flowlathe/core";
import { describe, expect, it } from "vitest";
import { createStateStore } from "./state-store.js";

function collect() {
  const events: RunEvent[] = [];
  return { events, emit: (e: RunEvent) => events.push(e) };
}

function tmpRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "flowlathe-state-store-")));
}

describe("createStateStore", () => {
  it("seeds declared initial values and applies each entry's merge rule on write", () => {
    const { emit } = collect();
    const store = createStateStore(emit, {
      decls: [
        { name: "findings", type: "array", merge: "append", initial: [] },
        { name: "count", type: "number", merge: "numeric-add" },
      ],
    });
    store.write("findings", "a");
    store.write("findings", "b");
    store.write("count", 3);
    store.write("count", 4);
    expect(store.read("findings")).toEqual(["a", "b"]);
    expect(store.read("count")).toBe(7);
  });

  it("rejects writes to an undeclared entry", () => {
    const { emit } = collect();
    const store = createStateStore(emit, { decls: [] });
    expect(() => store.write("nope", 1)).toThrow(/unknown state entry/);
  });

  it("emits state_write/state_read events carrying viaTool and the write's seq", () => {
    const { events, emit } = collect();
    const store = createStateStore(emit, { decls: [{ name: "x", type: "string", merge: "replace" }] });
    store.write("x", "hello", { viaTool: true, activationKey: "node-1" });
    store.read("x", { viaTool: true, activationKey: "node-2" });
    expect(events).toEqual([
      { kind: "state_write", entry: "x", value: "hello", merge: "replace", seq: 1, viaTool: true, activationKey: "node-1" },
      { kind: "state_read", entry: "x", seqSeen: 1, viaTool: true, activationKey: "node-2" },
    ]);
  });

  it("resumes from a replay log, continuing the seq counter", () => {
    const { emit } = collect();
    const store = createStateStore(emit, {
      decls: [{ name: "x", type: "string", merge: "replace" }],
      replay: [
        { entry: "x", value: "first", seq: 1 },
        { entry: "x", value: "second", seq: 2 },
      ],
    });
    expect(store.read("x")).toBe("second");
    store.write("x", "third");
    expect(store.read("x")).toBe("third");
  });

  it("error-on-conflict throws when a second writer disagrees", () => {
    const { emit } = collect();
    const store = createStateStore(emit, { decls: [{ name: "x", type: "string", merge: "error-on-conflict" }] });
    store.write("x", "a");
    expect(() => store.write("x", "b")).toThrow(/conflict/);
    store.write("x", "a"); // agreeing writes never conflict
  });

  describe("file-backed entries (PLAN-STATE-FILES.md)", () => {
    it("throws a clear error when a file-type decl exists but no fileConfig is given", () => {
      const { emit } = collect();
      expect(() =>
        createStateStore(emit, {
          decls: [{ name: "notes", type: "file", merge: "replace", fileMode: "read-write", filePath: "notes.md" }],
        }),
      ).toThrow(/FLOWLATHE_STATE_FILES_ROOT/);
    });

    it("non-versioned read-write: first write creates the file, replace overwrites, append extends, read returns current content", () => {
      const root = tmpRoot();
      const { emit } = collect();
      const store = createStateStore(emit, {
        decls: [{ name: "notes", type: "file", merge: "replace", fileMode: "read-write", filePath: "notes.md" }],
        fileConfig: { root, flowVersion: 1 },
      });

      store.write("notes", "first");
      expect(readFileSync(join(root, "notes.md"), "utf-8")).toBe("first");
      expect(store.read("notes")).toBe("first");

      store.write("notes", "second");
      expect(readFileSync(join(root, "notes.md"), "utf-8")).toBe("second");
    });

    it("append merge rule appends rather than replacing", () => {
      const root = tmpRoot();
      const { emit } = collect();
      const store = createStateStore(emit, {
        decls: [{ name: "log", type: "file", merge: "append", fileMode: "read-write", filePath: "log.txt" }],
        fileConfig: { root, flowVersion: 1 },
      });
      store.write("log", "one\n");
      store.write("log", "two\n");
      expect(readFileSync(join(root, "log.txt"), "utf-8")).toBe("one\ntwo\n");
    });

    it("versioned: mints a copy on first access (read first), reused on a later access, never mutating the template", () => {
      const root = tmpRoot();
      writeFileSync(join(root, "template.md"), "seed");
      const { emit } = collect();
      const store = createStateStore(emit, {
        decls: [
          { name: "doc", type: "file", merge: "replace", fileMode: "read-write", filePath: "template.md", versioned: true },
        ],
        fileConfig: { root, flowVersion: 5 },
      });

      expect(store.read("doc")).toBe("seed");
      store.write("doc", "edited");
      expect(store.read("doc")).toBe("edited");
      expect(readFileSync(join(root, "template.md"), "utf-8")).toBe("seed");

      const mintedFiles = readdirSync(root).filter((f) => f !== "template.md");
      expect(mintedFiles).toHaveLength(1);
      expect(mintedFiles[0]).toContain(".v5.");
    });

    it("versioned: mints on first WRITE too, and reuses that same path for a later read", () => {
      const root = tmpRoot();
      writeFileSync(join(root, "template.md"), "seed");
      const { emit } = collect();
      const store = createStateStore(emit, {
        decls: [
          { name: "doc", type: "file", merge: "replace", fileMode: "read-write", filePath: "template.md", versioned: true },
        ],
        fileConfig: { root, flowVersion: 1 },
      });
      store.write("doc", "first edit");
      const mintedAfterWrite = readdirSync(root).filter((f) => f !== "template.md");
      expect(mintedAfterWrite).toHaveLength(1);
      expect(store.read("doc")).toBe("first edit");
      const mintedAfterRead = readdirSync(root).filter((f) => f !== "template.md");
      expect(mintedAfterRead).toEqual(mintedAfterWrite);
    });

    it("read-only: write throws, read returns the live file with no copy minted", () => {
      const root = tmpRoot();
      writeFileSync(join(root, "resource.md"), "reference content");
      const { emit } = collect();
      const store = createStateStore(emit, {
        decls: [{ name: "doc", type: "file", merge: "replace", fileMode: "read-only", filePath: "resource.md" }],
        fileConfig: { root, flowVersion: 1 },
      });
      expect(store.read("doc")).toBe("reference content");
      expect(() => store.write("doc", "nope")).toThrow(/read-only/);
      expect(readdirSync(root)).toEqual(["resource.md"]);
    });

    it("state_write event carries a bounded preview, not the full content, for a large write", () => {
      const root = tmpRoot();
      const { events, emit } = collect();
      const store = createStateStore(emit, {
        decls: [{ name: "notes", type: "file", merge: "replace", fileMode: "read-write", filePath: "notes.md" }],
        fileConfig: { root, flowVersion: 1 },
      });
      const big = "x".repeat(10_000);
      store.write("notes", big);
      const writeEvent = events.find((e) => e.kind === "state_write") as { value: unknown };
      expect(typeof writeEvent.value).toBe("string");
      expect((writeEvent.value as string).length).toBeLessThan(big.length);
      expect(readFileSync(join(root, "notes.md"), "utf-8")).toBe(big); // the file itself is never truncated
    });

    it("a non-file entry in the same store is unaffected by fileConfig", () => {
      const root = tmpRoot();
      const { emit } = collect();
      const store = createStateStore(emit, {
        decls: [
          { name: "notes", type: "file", merge: "replace", fileMode: "read-write", filePath: "notes.md" },
          { name: "count", type: "number", merge: "numeric-add" },
        ],
        fileConfig: { root, flowVersion: 1 },
      });
      store.write("count", 2);
      store.write("count", 3);
      expect(store.read("count")).toBe(5);
    });
  });
});
