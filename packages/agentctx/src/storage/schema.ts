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

CREATE INDEX record_entities_entity ON record_entities(entity_id);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT,
  started_at TEXT,
  ended_at TEXT,
  tokens_injected INTEGER DEFAULT 0,
  extraction_cost_usd REAL DEFAULT 0
);
`;

/**
 * V2 — issue #78: `nodes` uniqueness must be per project, not global.
 *
 * V1 declares `name TEXT NOT NULL UNIQUE`, but nodes are project-scoped data
 * (`deleteProjectData` removes `nodes WHERE project_id = ?`). A global unique on
 * `name` means two projects that produce a node with the same name — e.g. a
 * `main` / `master` branch node, which is the common case — collide: the second
 * project's `INSERT OR IGNORE` is dropped and it silently reuses the first
 * project's node id, cross-linking its records to another project's entity.
 *
 * Rebuild `nodes` with a composite `UNIQUE(project_id, name)`. Node ids (the
 * PRIMARY KEY referenced by `record_entities` and `edges`) are preserved, so
 * existing links survive the table swap. `applyMigrations` disables foreign
 * keys around the migration (the SQLite-recommended procedure for table
 * rebuilds) and re-checks integrity before re-enabling them.
 */
const SCHEMA_V2 = `
CREATE TABLE nodes_new (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT,
  name TEXT NOT NULL,
  UNIQUE(project_id, name)
);

INSERT INTO nodes_new (id, project_id, kind, name)
  SELECT id, project_id, kind, name FROM nodes;

DROP TABLE nodes;

ALTER TABLE nodes_new RENAME TO nodes;
`;

/** Ordered migrations; index N migrates user_version N → N+1. Append-only. */
export const MIGRATIONS: readonly string[] = [SCHEMA_V1, SCHEMA_V2];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function currentSchemaVersion(db: Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

export function applyMigrations(db: Database): void {
  const startVersion = currentSchemaVersion(db);
  if (startVersion >= MIGRATIONS.length) return;

  // Table-rebuild migrations (CREATE new / copy / DROP old / RENAME) require
  // foreign keys to be disabled, and `PRAGMA foreign_keys` is a no-op inside a
  // transaction — so toggle it here, around the per-migration transactions, per
  // the SQLite procedure for schema changes. `defer_foreign_keys` is not enough:
  // dropping a parent table leaves a deferred-constraint count that a later
  // rename can't clear, so COMMIT fails even when no row is actually dangling.
  const foreignKeysEnabled = db.pragma("foreign_keys", { simple: true }) === 1;
  if (foreignKeysEnabled) db.pragma("foreign_keys = OFF");
  try {
    for (let version = startVersion; version < MIGRATIONS.length; version++) {
      const migration = MIGRATIONS[version];
      if (migration === undefined) break;
      db.transaction(() => {
        db.exec(migration);
        db.pragma(`user_version = ${version + 1}`);
      })();
    }

    if (foreignKeysEnabled) {
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(`migration left ${violations.length} foreign key violation(s)`);
      }
    }
  } finally {
    if (foreignKeysEnabled) db.pragma("foreign_keys = ON");
  }
}
