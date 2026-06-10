import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { insertRecord, supersedeRecord } from "../../src/storage/records.js";
import { searchRecords } from "../../src/storage/search.js";
import type { NewRecord } from "../../src/storage/types.js";
import { type TempDb, openTempDb } from "./helpers.js";

const PROJECT = "search-project";

function record(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    projectId: PROJECT,
    type: "decision",
    title: "Default title",
    body: "Default body",
    source: "cli",
    ...overrides,
  };
}

describe("searchRecords", () => {
  let tmp: TempDb;

  beforeEach(() => {
    tmp = openTempDb();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("finds records via FTS5 keyword match without a degraded marker", () => {
    insertRecord(
      tmp.db,
      record({ title: "Adopt gRPC", body: "Internal services move from REST to gRPC." }),
    );
    insertRecord(tmp.db, record({ title: "Indentation", body: "Two-space indentation." }));

    const outcome = searchRecords(tmp.db, PROJECT, "grpc services");
    expect(outcome.degraded).toBeUndefined();
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]?.record.title).toBe("Adopt gRPC");
  });

  it("ranks records matching more query terms higher", () => {
    insertRecord(
      tmp.db,
      record({ title: "Auth tokens", body: "JWT auth tokens rotate hourly via the auth service." }),
    );
    insertRecord(tmp.db, record({ title: "Logging", body: "We log auth failures." }));
    // Filler corpus so per-term IDF is meaningful (BM25 degenerates at N=2).
    for (let i = 0; i < 5; i++) {
      insertRecord(tmp.db, record({ title: `Filler ${i}`, body: "Unrelated build tooling note." }));
    }

    const outcome = searchRecords(tmp.db, PROJECT, "auth tokens rotate");
    expect(outcome.results[0]?.record.title).toBe("Auth tokens");
  });

  it("never surfaces superseded records (Invariant 3)", () => {
    const rest = insertRecord(
      tmp.db,
      record({ title: "Use REST", body: "REST for all public APIs." }),
    );
    supersedeRecord(tmp.db, rest.id, {
      title: "Use gRPC",
      body: "gRPC replaces REST for all public APIs.",
      source: "cli",
    });

    const outcome = searchRecords(tmp.db, PROJECT, "REST APIs");
    expect(outcome.results.map((h) => h.record.title)).toEqual(["Use gRPC"]);
  });

  it("boosts pinned records in the rerank", () => {
    insertRecord(tmp.db, record({ title: "Caching A", body: "Caching strategy notes." }));
    insertRecord(
      tmp.db,
      record({ title: "Caching B", body: "Caching strategy notes.", pinned: true }),
    );

    const outcome = searchRecords(tmp.db, PROJECT, "caching strategy");
    expect(outcome.results[0]?.record.title).toBe("Caching B");
  });

  it("filters by type when requested", () => {
    insertRecord(tmp.db, record({ type: "decision", title: "Testing decision", body: "vitest" }));
    insertRecord(
      tmp.db,
      record({ type: "convention", title: "Testing convention", body: "vitest everywhere" }),
    );

    const outcome = searchRecords(tmp.db, PROJECT, "vitest", { type: "convention" });
    expect(outcome.results.map((h) => h.record.type)).toEqual(["convention"]);
  });

  it("scopes results to own project + global only", () => {
    insertRecord(tmp.db, record({ title: "Mine", body: "topic alpha" }));
    insertRecord(tmp.db, record({ projectId: "other", title: "Theirs", body: "topic alpha" }));
    insertRecord(
      tmp.db,
      record({
        projectId: "_global",
        type: "preference",
        scope: "global",
        title: "Global pref",
        body: "topic alpha",
      }),
    );

    const titles = searchRecords(tmp.db, PROJECT, "alpha").results.map((h) => h.record.title);
    expect(titles).toContain("Mine");
    expect(titles).toContain("Global pref");
    expect(titles).not.toContain("Theirs");
  });

  it("returns no results (and no error) for empty queries", () => {
    expect(searchRecords(tmp.db, PROJECT, "   ")).toEqual({ results: [] });
  });

  it("does not throw on raw prompt text with FTS5 operators", () => {
    insertRecord(
      tmp.db,
      record({ title: "Quote handling", body: 'Use "double quotes" AND care.' }),
    );
    const outcome = searchRecords(tmp.db, PROJECT, 'why does "double quotes" AND (NOT) fail?');
    expect(outcome.results.length).toBeGreaterThan(0);
  });

  it("falls back to LIKE with a degraded marker when FTS5 is unusable", () => {
    insertRecord(tmp.db, record({ title: "Fallback", body: "find me via like" }));
    // Simulate FTS5 loss (SPEC §8 rung 4) by dropping the virtual table.
    tmp.db.exec("DROP TRIGGER records_fts_ai; DROP TRIGGER records_fts_ad;");
    tmp.db.exec("DROP TRIGGER records_fts_au; DROP TABLE records_fts;");

    const outcome = searchRecords(tmp.db, PROJECT, "fallback");
    expect(outcome.degraded).toBe("like-search");
    expect(outcome.results[0]?.record.title).toBe("Fallback");
  });
});
