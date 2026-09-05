import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { ensureDefaultMockProvider, openDb, runMigrations } from "@flowlathe/persistence";
import { buildApp } from "./app.js";
import { resolveCredentialKey } from "./credential-key.js";
import { SchedulerRegistry } from "./scheduler-registry.js";

const here = dirname(fileURLToPath(import.meta.url));

const port = Number(process.env["PORT"] ?? 4310);
const dbPath = process.env["FLOWLATHE_DB_PATH"] ?? join(here, "..", "data", "flowlathe.sqlite");
const dataDir = process.env["FLOWLATHE_DATA_DIR"] ?? dirname(dbPath);
const staticRoot = process.env["FLOWLATHE_STATIC_ROOT"] ?? join(here, "..", "..", "web", "dist");

mkdirSync(dirname(dbPath), { recursive: true });

const opened = openDb(dbPath);
runMigrations(opened);
ensureDefaultMockProvider(opened.db);

const credentialKey = resolveCredentialKey(dataDir);
const schedulerRegistry = new SchedulerRegistry(opened.db, credentialKey);

const app = buildApp({ db: opened.db, credentialKey, schedulerRegistry, staticRoot });

app.listen({ port, host: "127.0.0.1" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`flowlathe server listening on ${address}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    app
      .close()
      .catch(() => undefined)
      .finally(() => {
        opened.close();
        process.exit(0);
      });
  });
}
