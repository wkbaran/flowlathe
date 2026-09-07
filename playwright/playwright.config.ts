import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const dbPath = join(tmpdir(), `flowlathe-e2e-${randomUUID()}.sqlite`);
// PLAN-FLOW-DSL.md S3: every flow save now writes a `.flow` file too. Without an explicit
// FLOWLATHE_FLOWS_DIR, the server defaults to `./flows` relative to its own cwd — which, under
// `pnpm --filter @flowlathe/server start`, is packages/server, i.e. inside the repo. Point it at
// a throwaway tmp dir instead, exactly like FLOWLATHE_DB_PATH already does, so running the e2e
// suite never litters the working tree.
//
// Exported so a spec that needs to simulate an *external* file edit (slice8-dsl-file-sync.spec.ts)
// can write directly into the same directory the server's own FLOWLATHE_FLOWS_DIR points at —
// but this config module is evaluated independently in the main Playwright process (which starts
// webServer below) AND again in the worker process that runs the spec file (a separate Node
// process, no shared module cache), so computing `join(tmpdir(), ...randomUUID())` here directly
// would produce two DIFFERENT directories. Stash it in process.env instead: workers inherit their
// parent's env, so the value set on first evaluation (by the main process) is simply read back
// on the worker's independent re-evaluation, rather than recomputed.
export const flowsDir =
  process.env["FLOWLATHE_FLOWS_DIR"] ?? join(tmpdir(), `flowlathe-e2e-flows-${randomUUID()}`);
process.env["FLOWLATHE_FLOWS_DIR"] = flowsDir;
const port = 4311;

export default defineConfig({
  testDir: "./tests",
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
  },
  webServer: {
    command: "pnpm --filter @flowlathe/web build && pnpm --filter @flowlathe/server start",
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(port),
      FLOWLATHE_DB_PATH: dbPath,
      FLOWLATHE_FLOWS_DIR: flowsDir,
    },
  },
});
