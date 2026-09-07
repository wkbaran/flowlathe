import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFlowGraph, type FlowGraph } from "@flowlathe/core";
import { createFlow, getFlow, openDb, runMigrations, type OpenedDb } from "@flowlathe/persistence";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  autoExportIfEmpty,
  canonicalTextFor,
  exportAllFlowsToDir,
  getLatestGraphForFlowVersionFileAware,
  loadFlowFile,
  syncAllFlowFiles,
  syncFlowFile,
  watchFlowsDir,
} from "./flow-store.js";

const CHAIN: FlowGraph = {
  nodes: [
    { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "start", providerId: "mock", modelId: "m" } },
    { id: "b", type: "prompt", position: { x: 1, y: 0 }, data: { template: "next: {{input}}", providerId: "mock", modelId: "m" } },
  ],
  edges: [{ id: "a.output->b.input", source: "a", target: "b", sourceHandle: "output", targetHandle: "input" }],
  state: [],
};

let opened: OpenedDb;
let dir: string;

beforeEach(async () => {
  opened = openDb(":memory:");
  runMigrations(opened);
  dir = await mkdtemp(join(tmpdir(), "flowlathe-flow-store-"));
});

afterEach(async () => {
  opened.close();
  await rm(dir, { recursive: true, force: true });
});

describe("loadFlowFile", () => {
  it("returns undefined for a missing file", () => {
    expect(loadFlowFile(dir, "nope")).toBeUndefined();
  });

  it("parses a real file into name/graph/canonical sourceText", async () => {
    await writeFile(join(dir, "chain.flow"), canonicalTextFor("chain", CHAIN));
    const loaded = loadFlowFile(dir, "chain");
    expect(loaded?.name).toBe("chain");
    expect(loaded?.graph).toEqual(CHAIN);
    expect(loaded?.sourceText).toBe(canonicalTextFor("chain", CHAIN));
  });
});

describe("syncFlowFile", () => {
  it("creates a new flow row (id = slug) from a file with no matching flow yet", async () => {
    await writeFile(join(dir, "chain.flow"), canonicalTextFor("chain", CHAIN));
    const outcome = syncFlowFile(opened.db, dir, "chain");
    expect(outcome).toEqual({ slug: "chain", changed: true });
    const flow = getFlow(opened.db, "chain");
    expect(flow?.graph).toEqual(CHAIN);
    expect(flow?.name).toBe("chain");
  });

  it("is a no-op (changed: false) when the file's content hasn't changed", async () => {
    await writeFile(join(dir, "chain.flow"), canonicalTextFor("chain", CHAIN));
    syncFlowFile(opened.db, dir, "chain");
    const before = getFlow(opened.db, "chain")!;
    const outcome = syncFlowFile(opened.db, dir, "chain");
    expect(outcome.changed).toBe(false);
    expect(getFlow(opened.db, "chain")!.flowVersionId).toBe(before.flowVersionId);
  });

  it("snapshots a new version when the file's content changes", async () => {
    await writeFile(join(dir, "chain.flow"), canonicalTextFor("chain", CHAIN));
    syncFlowFile(opened.db, dir, "chain");
    const before = getFlow(opened.db, "chain")!;
    await writeFile(join(dir, "chain.flow"), canonicalTextFor("chain", emptyFlowGraph()));
    const outcome = syncFlowFile(opened.db, dir, "chain");
    expect(outcome.changed).toBe(true);
    const after = getFlow(opened.db, "chain")!;
    expect(after.flowVersionId).not.toBe(before.flowVersionId);
    expect(after.graph).toEqual(emptyFlowGraph());
  });

  it("picks up a renamed flow header without changing the id", async () => {
    await writeFile(join(dir, "chain.flow"), canonicalTextFor("chain", CHAIN));
    syncFlowFile(opened.db, dir, "chain");
    await writeFile(join(dir, "chain.flow"), canonicalTextFor("renamed chain", CHAIN));
    syncFlowFile(opened.db, dir, "chain");
    const flow = getFlow(opened.db, "chain")!;
    expect(flow.name).toBe("renamed chain");
    expect(flow.id).toBe("chain");
  });

  it("reports a parse error without throwing", async () => {
    await writeFile(join(dir, "bad.flow"), "flow ??? {");
    const outcome = syncFlowFile(opened.db, dir, "bad");
    expect(outcome.changed).toBe(false);
    expect(outcome.error).toBeDefined();
  });

  it("reports a missing file without throwing", () => {
    const outcome = syncFlowFile(opened.db, dir, "nope");
    expect(outcome.error).toContain("not found");
  });
});

describe("syncAllFlowFiles", () => {
  it("syncs every *.flow file in the directory", async () => {
    await writeFile(join(dir, "chain.flow"), canonicalTextFor("chain", CHAIN));
    await writeFile(join(dir, "empty.flow"), canonicalTextFor("empty", emptyFlowGraph()));
    await writeFile(join(dir, "ignore.txt"), "not a flow file");
    const outcomes = syncAllFlowFiles(opened.db, dir);
    expect(outcomes.map((o) => o.slug).sort()).toEqual(["chain", "empty"]);
    expect(getFlow(opened.db, "chain")).toBeDefined();
    expect(getFlow(opened.db, "empty")).toBeDefined();
  });

  it("returns an empty list for a directory that doesn't exist yet", () => {
    expect(syncAllFlowFiles(opened.db, join(dir, "nope"))).toEqual([]);
  });
});

describe("exportAllFlowsToDir / autoExportIfEmpty", () => {
  it("writes one .flow file per DB flow", () => {
    createFlow(opened.db, "My Flow", CHAIN);
    exportAllFlowsToDir(opened.db, dir);
    return readdir(dir).then(async (files) => {
      expect(files).toEqual(["my-flow.flow"]);
      expect(await readFile(join(dir, "my-flow.flow"), "utf8")).toBe(canonicalTextFor("My Flow", CHAIN));
    });
  });

  it("auto-exports only when the dir has no .flow files yet and the DB has flows", async () => {
    createFlow(opened.db, "My Flow", CHAIN);
    const exported = autoExportIfEmpty(opened.db, dir);
    expect(exported).toBe(true);
    expect(await readdir(dir)).toEqual(["my-flow.flow"]);

    await writeFile(join(dir, "my-flow.flow"), "flow \"changed on disk\" {}\n");
    const secondCall = autoExportIfEmpty(opened.db, dir);
    expect(secondCall).toBe(false);
    expect(await readFile(join(dir, "my-flow.flow"), "utf8")).toBe('flow "changed on disk" {}\n');
  });

  it("does nothing for an empty dir and an empty DB", () => {
    expect(autoExportIfEmpty(opened.db, dir)).toBe(false);
  });
});

describe("getLatestGraphForFlowVersionFileAware", () => {
  it("prefers the on-disk file over the DB's stored graph", async () => {
    const created = createFlow(opened.db, "chain", CHAIN, { id: "chain" });
    await writeFile(join(dir, "chain.flow"), canonicalTextFor("chain", emptyFlowGraph()));
    const graph = getLatestGraphForFlowVersionFileAware(opened.db, dir, created.flowVersionId);
    expect(graph).toEqual(emptyFlowGraph());
  });

  it("falls back to the DB's latest row when the file is gone", () => {
    const created = createFlow(opened.db, "chain", CHAIN, { id: "chain" });
    const graph = getLatestGraphForFlowVersionFileAware(opened.db, dir, created.flowVersionId);
    expect(graph).toEqual(CHAIN);
  });

  it("returns undefined for an unknown version id", () => {
    expect(getLatestGraphForFlowVersionFileAware(opened.db, dir, "nope")).toBeUndefined();
  });
});

describe("watchFlowsDir", () => {
  it("debounces and fires onChange once per settled .flow file", async () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const stop = watchFlowsDir(dir, (slug) => seen.push(slug));
    try {
      await writeFile(join(dir, "chain.flow"), "flow \"a\" {}\n");
      await writeFile(join(dir, "chain.flow"), "flow \"b\" {}\n");
      await vi.advanceTimersByTimeAsync(500);
      expect(seen).toEqual(["chain"]);
    } finally {
      stop();
      vi.useRealTimers();
    }
  });
});
