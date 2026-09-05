import DatabaseConstructor, { type Database as SqliteDatabase } from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

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
  const db = drizzle(sqlite, { schema });
  return { db, sqlite, close: () => sqlite.close() };
}
