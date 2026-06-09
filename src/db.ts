import "dotenv/config";
import { resolve } from "node:path";
import Database from "better-sqlite3";

// The single SQLite database for the whole app (yappr.db). One shared connection that
// every feature needing storage opens through getDb() — stats today, more tables
// later. Each feature owns its own `CREATE TABLE IF NOT EXISTS` (see stats.ts), so
// adding a table is local to that feature; this module just owns the connection and
// pragmas.
//
// Path comes from DB_PATH. On the server that points *outside* the redeploy-wiped
// /yappr dir (so data survives deploys); locally it defaults to ./yappr.db. Opening
// is best-effort: a DB that won't open returns null, and callers degrade to no-ops
// rather than crashing the agent.

const DB_PATH = process.env.DB_PATH || resolve(process.cwd(), "yappr.db");

let db: Database.Database | null = null;
let initFailed = false;

export function getDb(): Database.Database | null {
  if (db) return db;
  if (initFailed) return null;
  try {
    const handle = new Database(DB_PATH);
    handle.pragma("journal_mode = WAL");  // concurrent readers (the CLI) alongside the writer
    handle.pragma("busy_timeout = 5000"); // wait out a brief writer lock instead of erroring
    db = handle;
    return db;
  } catch {
    initFailed = true;
    return null;
  }
}

const ensured = new Set<string>();

// Get the shared connection with a feature's tables guaranteed to exist. Pass the
// feature's `CREATE TABLE IF NOT EXISTS …` DDL; it runs once per process (memoised on
// the DDL text). Returns null if the DB can't be opened, so callers stay best-effort.
// This is how each feature owns its own schema while sharing one connection.
export function withSchema(ddl: string): Database.Database | null {
  const d = getDb();
  if (!d) return null;
  if (!ensured.has(ddl)) {
    try {
      d.exec(ddl);
      ensured.add(ddl);
    } catch {
      return null;
    }
  }
  return d;
}
