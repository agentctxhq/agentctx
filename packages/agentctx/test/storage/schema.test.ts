import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasFts5, openDatabase } from "../../src/storage/db.js";
import { SCHEMA_VERSION, currentSchemaVersion } from "../../src/storage/schema.js";
import { type TempDb, openTempDb } from "./helpers.js";

describe("database bootstrap", () => {
  let tmp: TempDb;

  beforeEach(() => {
    tmp = openTempDb();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("enables WAL mode", () => {
    expect(tmp.db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("has FTS5 compiled in", () => {
    expect(hasFts5(tmp.db)).toBe(true);
  });

  it("advances user_version to the current schema version", () => {
    expect(currentSchemaVersion(tmp.db)).toBe(SCHEMA_VERSION);
  });

  it("creates all SPEC §3.1 tables", () => {
    const names = (
      tmp.db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const table of [
      "records",
      "records_fts",
      "nodes",
      "edges",
      "record_entities",
      "sessions",
    ]) {
      expect(names).toContain(table);
    }
  });

  it("creates the FTS5 sync trigger trio and edge indexes", () => {
    const triggers = (
      tmp.db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(triggers).toContain("records_fts_ai");
    expect(triggers).toContain("records_fts_ad");
    expect(triggers).toContain("records_fts_au");

    const indexes = (
      tmp.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(indexes).toContain("edges_from");
    expect(indexes).toContain("edges_to");
  });

  it("is idempotent — reopening an existing database applies nothing twice", () => {
    tmp.db.close();
    // Hand the reopened connection back to the helper so cleanup closes it.
    tmp.db = openDatabase(tmp.path);
    expect(currentSchemaVersion(tmp.db)).toBe(SCHEMA_VERSION);
    expect(tmp.db.prepare("SELECT COUNT(*) AS n FROM records").get()).toEqual({ n: 0 });
  });
});
