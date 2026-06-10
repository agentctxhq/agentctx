/**
 * Database bootstrap (ADR-002/003): single SQLite file, WAL mode, no daemon.
 * Every caller opens, works, and closes — concurrency is WAL's job.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { applyMigrations } from "./schema.js";
import { StorageError } from "./types.js";

export function defaultDbPath(): string {
  return join(homedir(), ".agentctx", "agentctx.db");
}

/**
 * Open (creating if needed) an agentctx database. Idempotent: safe to call
 * against an existing database; pending migrations are applied.
 *
 * @param path Database file path; defaults to `~/.agentctx/agentctx.db`.
 */
export function openDatabase(path: string = defaultDbPath()): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  assertFts5(db);
  applyMigrations(db);
  return db;
}

/** Probe whether the linked SQLite has FTS5 compiled in (SPEC §2.1). */
export function hasFts5(db: Database.Database): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(probe)");
    db.exec("DROP TABLE temp.fts5_probe");
    return true;
  } catch {
    return false;
  }
}

function assertFts5(db: Database.Database): void {
  if (!hasFts5(db)) {
    db.close();
    throw new StorageError(
      "fts5_unavailable",
      "The bundled SQLite lacks FTS5 — agentctx requires better-sqlite3's bundled build. " +
        "Reinstall dependencies (npm ci) rather than linking against a system SQLite.",
    );
  }
}
