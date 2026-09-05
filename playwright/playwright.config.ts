import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const dbPath = join(tmpdir(), `flowlathe-e2e-${randomUUID()}.sqlite`);
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
    },
  },
});
