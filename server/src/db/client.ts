import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export type DB = BetterSQLite3Database<typeof schema>;

// MIGRATIONS_DIR lets a bundled build (server/dist) point at the migrations folder.
const MIGRATIONS_FOLDER = process.env.MIGRATIONS_DIR
  ? path.resolve(process.cwd(), process.env.MIGRATIONS_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * Opens (or creates) the SQLite database file.
 * Pass ':memory:' for a throwaway database (used by tests).
 */
export function openDatabase(databasePath: string): { db: DB; sqlite: Database.Database } {
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }
  const sqlite = new Database(databasePath);
  // WAL lets readers and the writer work at the same time and survives crashes well.
  sqlite.pragma('journal_mode = WAL');
  // SQLite does not enforce foreign keys unless asked to.
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/** Applies any SQL migrations in server/drizzle/ that have not run yet. Safe to call repeatedly. */
export function runMigrations(db: DB): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
