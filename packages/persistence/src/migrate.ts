import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openDb, type OpenedDb } from "./db.js";

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function runMigrations(opened: OpenedDb): void {
  migrate(opened.db, { migrationsFolder });
}

async function main() {
  const path = process.argv[2] ?? process.env["FLOWLATHE_DB_PATH"];
  if (!path) throw new Error("usage: tsx src/migrate.ts <db-path>");
  const opened = openDb(path);
  runMigrations(opened);
  opened.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
