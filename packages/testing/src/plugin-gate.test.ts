import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileGraph } from "@flowlathe/compiler";
import type { FlowGraph } from "@flowlathe/core";
import { describe, expect, it } from "vitest";

const srcDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(srcDir, "..");
const tsxBin = join(packageDir, "node_modules", ".bin", "tsx");
const scratchRoot = join(packageDir, ".parity-tmp");

function runCompiled(graph: FlowGraph): { status: number | null; stderr: string } {
  const script = compileGraph(graph, { providers: { mock: { kind: "mock" } } });
  mkdirSync(scratchRoot, { recursive: true });
  const dir = mkdtempSync(join(scratchRoot, "gate-"));
  const file = join(dir, "flow.ts");
  writeFileSync(file, script);
  const result = spawnSync(tsxBin, [file], { encoding: "utf-8", cwd: packageDir });
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
});
