/**
 * Schema DDL and migration scaffold.
 *
 * The normative schema lives in SPEC.md §3.1 — this file is its executable
 * copy. Migrations are versioned via `PRAGMA user_version`: each entry in
 * MIGRATIONS moves the database from version N to N+1, applied in a
 * transaction. Bootstrap and upgrade are the same idempotent code path.
 */
import type { Database } from "better-sqlite3";

const SCHEMA_V1 = `
CREATE TABLE records (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  type            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  scope           TEXT DEFAULT 'project',
  pinned          INTEGER DEFAULT 0,
  confidence      TEXT DEFAULT 'inferred',
  reinforce_count INTEGER DEFAULT 0,
  valid_from      TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  superseded_at   TEXT,
  superseded_by   TEXT REFERENCES records(id),
  access_count    INTEGER DEFAULT 0,
  last_accessed   TEXT,
  score           REAL DEFAULT 1.0,
  claudemd_drift_score REAL DEFAULT 0.0,
  source          TEXT NOT NULL,
  session_id      TEXT,
  pending_embedding INTEGER DEFAULT 1
);

CREATE INDEX records_project_current ON records(project_id, type) WHERE superseded_at IS NULL;

CREATE VIRTUAL TABLE records_fts USING fts5(title, body, content=records, content_rowid=rowid);

CREATE TRIGGER records_fts_ai AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TRIGGER records_fts_ad AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER records_fts_au AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, body)
    VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO records_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  rel_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0
);

CREATE INDEX edges_from ON edges(from_id);
CREATE INDEX edges_to ON edges(to_id);

CREATE TABLE record_entities (
  record_id TEXT NOT NULL REFERENCES records(id),
  entity_id TEXT NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (record_id, entity_id)
);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  tokens_injected INTEGER DEFAULT 0,
  extraction_cost_usd REAL DEFAULT 0
);
`;

/** Ordered migrations; index N migrates user_version N → N+1. Append-only. */
export const MIGRATIONS: readonly string[] = [SCHEMA_V1];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function currentSchemaVersion(db: Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

export function applyMigrations(db: Database): void {
  for (let version = currentSchemaVersion(db); version < MIGRATIONS.length; version++) {
    const migration = MIGRATIONS[version];
    if (migration === undefined) break;
    db.transaction(() => {
      db.exec(migration);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
