import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, SCHEMA_VERSION, applyMigrations } from "../../src/storage/schema.js";

/**
 * Issue #78: the V2 migration rebuilds `nodes` to swap the global `name UNIQUE`
 * for `UNIQUE(project_id, name)`. A rebuild drops the table that
 * `record_entities`/`edges` reference, so these tests pin the upgrade path:
 * existing node ids (and their inbound links) must survive, and foreign keys
 * must be re-enabled and intact afterward.
 */
describe("schema migration V1 → V2 (issue #78)", () => {
  let dir: string;
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentctx-mig-"));
    db = new Database(join(dir, "agentctx.db"));
    db.pragma("foreign_keys = ON");
    // Bring the database up to V1 only, then seed a linked node as a v0.1
    // install would have it.
    db.transaction(() => {
      db.exec(MIGRATIONS[0] as string);
      db.pragma("user_version = 1");
    })();
    db.prepare(
      `INSERT INTO records (id, project_id, type, title, body, valid_from, recorded_at, source)
       VALUES ('rec1', 'projectA', 'decision', 't', 'b', 'x', 'x', 'cli')`,
    ).run();
    db.prepare(
      "INSERT INTO nodes (id, project_id, kind, name) VALUES ('node1', 'projectA', 'branch', 'main')",
    ).run();
    db.prepare("INSERT INTO record_entities (record_id, entity_id) VALUES ('rec1', 'node1')").run();
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("advances to the current schema version", () => {
    applyMigrations(db);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
  });

  it("preserves node ids and their record links across the nodes rebuild", () => {
    applyMigrations(db);

    const node = db.prepare("SELECT id, project_id, name FROM nodes WHERE id = 'node1'").get();
    expect(node).toEqual({ id: "node1", project_id: "projectA", name: "main" });

    const link = db.prepare("SELECT entity_id FROM record_entities WHERE record_id = 'rec1'").get();
    expect(link).toEqual({ entity_id: "node1" });
  });

  it("re-enables foreign keys with no integrity violations", () => {
    applyMigrations(db);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("allows the same node name in a different project after the upgrade", () => {
    applyMigrations(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO nodes (id, project_id, kind, name) VALUES ('node2', 'projectB', 'branch', 'main')",
        )
        .run(),
    ).not.toThrow();
  });
});
