import { createServer, type Server } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileGraph } from "@flowlathe/compiler";
import type { FlowGraph, ToolRegistration } from "@flowlathe/core";
import { createSearxngToolset, SearxngClient } from "@flowlathe/plugin-searxng";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(srcDir, "..");
const tsxBin = join(packageDir, "node_modules", ".bin", "tsx");
const scratchRoot = join(packageDir, ".parity-tmp");

function runCompiled(
  graph: FlowGraph,
  opts: { toolsets?: ToolRegistration[]; env?: Record<string, string> } = {},
): { status: number | null; stderr: string } {
  const script = compileGraph(graph, { providers: { mock: { kind: "mock" } }, toolsets: opts.toolsets });
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, "gate-"));
  const file = join(dir, "flow.ts");
  writeFileSync(file, script);
  const result = spawnSync(tsxBin, [file], { encoding: "utf-8", cwd: packageDir, env: { ...process.env, ...opts.env } });
  return { status: result.status, stderr: result.stderr };
}

describe("compiled-script plugin dependency gate", () => {
  it(
    "exits non-zero with a clear message for a flow requiring an unsupported plugin toolset, without calling the provider",
    () => {
      const graph: FlowGraph = {
        nodes: [
          {
            id: "a",
            type: "prompt",
            position: { x: 0, y: 0 },
            data: { template: "hi", providerId: "mock", modelId: "m", enabledToolsets: ["spotify"] },
          },
        ],
        edges: [],
        state: [],
      };
      const { status, stderr } = runCompiled(graph);
      expect(status).toBe(1);
      expect(stderr).toContain("spotify");
      expect(stderr).toContain("not supported in exported scripts");
    },
    15_000,
  );

  it(
    "runs normally when no node requires a plugin toolset",
    () => {
      const graph: FlowGraph = {
        nodes: [{ id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "hi", providerId: "mock", modelId: "m" } }],
        edges: [],
        state: [],
      };
      const { status, stderr } = runCompiled(graph);
      expect(status).toBe(0);
      expect(stderr).toBe("");
    },
    15_000,
  );

  describe("file-backed state entries (PLAN-STATE-FILES.md)", () => {
    it(
      "exits non-zero with a clear message for a flow declaring a type:\"file\" state entry, without touching the scheduler",
      () => {
        const graph: FlowGraph = {
          nodes: [
            { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "notes: {{notes}}", providerId: "mock", modelId: "m" } },
          ],
          edges: [],
          state: [{ name: "notes", type: "file", merge: "replace", fileMode: "read-write", filePath: "notes.md" }],
        };
        const { status, stderr } = runCompiled(graph);
        expect(status).toBe(1);
        expect(stderr).toContain("notes");
        expect(stderr).toContain("not supported in exported scripts");
      },
      15_000,
    );

    it(
      "runs normally when the only state entries are non-file (the ambient-binding mechanism itself works standalone)",
      () => {
        const graph: FlowGraph = {
          nodes: [
            { id: "a", type: "prompt", position: { x: 0, y: 0 }, data: { template: "notes: {{notes}}", providerId: "mock", modelId: "m" } },
          ],
          edges: [],
          state: [{ name: "notes", type: "string", merge: "replace", initial: "hello" }],
        };
        const { status, stderr } = runCompiled(graph);
        expect(status).toBe(0);
        expect(stderr).toBe("");
      },
      15_000,
    );
  });

  describe("a toolset with a standalone reconstruction", () => {
    let server: Server;
    let baseUrl: string;

    beforeAll(async () => {
      server = createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ results: [] }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected a bound TCP address");
      baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    });

    it(
      "exports to a script that actually runs, reconstructing the toolset from env at runtime",
      () => {
        const graph: FlowGraph = {
          nodes: [
            {
              id: "a",
              type: "prompt",
              position: { x: 0, y: 0 },
              data: { template: "hi", providerId: "mock", modelId: "m", enabledToolsets: ["searxng"] },
            },
          ],
          edges: [],
          state: [],
        };
        const toolsets = createSearxngToolset(new SearxngClient({ baseUrl }));
        const { status, stderr } = runCompiled(graph, { toolsets, env: { SEARXNG_BASE_URL: baseUrl } });
        expect(stderr).toBe("");
        expect(status).toBe(0);
      },
      15_000,
    );
  });
});
