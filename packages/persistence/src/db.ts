import DatabaseConstructor, { type Database as SqliteDatabase } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema> & { $client: SqliteDatabase };

export interface OpenedDb {
  db: Db;
  sqlite: SqliteDatabase;
  close(): void;
}

export function openDb(path: string): OpenedDb {
  const sqlite = new DatabaseConstructor(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("synchronous = NORMAL");
  sqlite.pragma("busy_timeout = 5000");
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}

/** better-sqlite3's own transaction wrapper, driven through drizzle's underlying client so
 *  drizzle query builders on the same `Db` participate. Unlike `db.transaction(fn)` this keeps
 *  the `Db` type, so every existing helper works unchanged inside it. Re-entrant (better-sqlite3
 *  falls back to SAVEPOINT). `.immediate()` takes the write lock up front so a concurrent writer
 *  — the CLI running against a live server's DB — fails fast rather than deadlocking on a
 *  deferred-to-write upgrade. */
export function withTransaction<T>(db: Db, fn: () => T): T {
  return db.$client.transaction(fn).immediate();
}
