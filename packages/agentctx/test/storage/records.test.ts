import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getRecord,
  insertRecord,
  listRecords,
  supersedeRecord,
} from "../../src/storage/records.js";
import { type NewRecord, StorageError } from "../../src/storage/types.js";
import { type TempDb, openTempDb } from "./helpers.js";

const PROJECT = "test-project";

function decision(overrides: Partial<NewRecord> = {}): NewRecord {
  return {
    projectId: PROJECT,
    type: "decision",
    title: "Use SQLite via better-sqlite3",
    body: "node:sqlite lacks FTS5; better-sqlite3 ships it compiled in.",
    source: "cli",
    ...overrides,
  };
}

describe("record store", () => {
  let tmp: TempDb;

  beforeEach(() => {
    tmp = openTempDb();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  describe("validation", () => {
    it.each([
      ["invalid_type", decision({ type: "memo" as NewRecord["type"] })],
      ["invalid_scope", decision({ scope: "team" as NewRecord["scope"] })],
      ["invalid_confidence", decision({ confidence: "high" as NewRecord["confidence"] })],
      ["invalid_source", decision({ source: "manual" as NewRecord["source"] })],
      ["empty_title", decision({ title: "   " })],
      ["empty_body", decision({ body: "" })],
      ["title_too_long", decision({ title: "x".repeat(121) })],
      ["body_too_long", decision({ body: "x".repeat(2001) })],
    ])("rejects %s", (code, input) => {
      let caught: unknown;
      try {
        insertRecord(tmp.db, input);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect((caught as StorageError).code).toBe(code);
      expect(listRecords(tmp.db, PROJECT)).toHaveLength(0);
    });

    it("accepts boundary lengths (120-char title, 2000-char body)", () => {
      const record = insertRecord(
        tmp.db,
        decision({ title: "t".repeat(120), body: "b".repeat(2000) }),
      );
      expect(record.title).toHaveLength(120);
    });
  });

  describe("insert and retrieval", () => {
    it("round-trips a record with bi-temporal defaults", () => {
      const created = insertRecord(tmp.db, decision());
      const fetched = getRecord(tmp.db, created.id);
      expect(fetched).toEqual(created);
      expect(created.validFrom).toBe(created.recordedAt);
      expect(created.supersededAt).toBeNull();
      expect(created.confidence).toBe("inferred");
      expect(created.scope).toBe("project");
      expect(created.pendingEmbedding).toBe(true);
    });

    it("returns null for unknown ids", () => {
      expect(getRecord(tmp.db, "01HZZZZZZZZZZZZZZZZZZZZZZZ")).toBeNull();
    });
  });

  describe("explicit supersession (SPEC §3.5)", () => {
    it("atomically marks the old record and creates the replacement", () => {
      const rest = insertRecord(tmp.db, decision({ title: "Use REST" }));
      const { old, replacement } = supersedeRecord(tmp.db, rest.id, {
        title: "Use gRPC",
        body: "We moved from REST to gRPC for internal services.",
        source: "mcp_tool",
      });

      expect(old.supersededAt).not.toBeNull();
      expect(old.supersededBy).toBe(replacement.id);
      expect(replacement.type).toBe(old.type);
      expect(replacement.scope).toBe(old.scope);
      expect(replacement.confidence).toBe("explicit");

      // Default retrieval never surfaces the superseded record (Invariant 3).
      expect(getRecord(tmp.db, rest.id)).toBeNull();
      expect(getRecord(tmp.db, rest.id, { includeSuperseded: true })).not.toBeNull();
      const visible = listRecords(tmp.db, PROJECT);
      expect(visible.map((r) => r.id)).toEqual([replacement.id]);
      expect(listRecords(tmp.db, PROJECT, { includeSuperseded: true })).toHaveLength(2);
    });

    it("fails with already_superseded when superseding a non-head record", () => {
      const first = insertRecord(tmp.db, decision());
      supersedeRecord(tmp.db, first.id, { title: "v2", body: "second", source: "cli" });
      expect(() =>
        supersedeRecord(tmp.db, first.id, { title: "v3", body: "third", source: "cli" }),
      ).toThrowError(expect.objectContaining({ code: "already_superseded" }));
    });

    it("fails with record_not_found for unknown ids", () => {
      expect(() =>
        supersedeRecord(tmp.db, "nope", { title: "x", body: "y", source: "cli" }),
      ).toThrowError(expect.objectContaining({ code: "record_not_found" }));
    });

    it("leaves the old record untouched when the replacement insert fails", () => {
      const first = insertRecord(tmp.db, decision());
      expect(() =>
        supersedeRecord(tmp.db, first.id, { title: "x".repeat(200), body: "y", source: "cli" }),
      ).toThrowError(expect.objectContaining({ code: "title_too_long" }));
      const stillCurrent = getRecord(tmp.db, first.id);
      expect(stillCurrent?.supersededAt).toBeNull();
      expect(listRecords(tmp.db, PROJECT)).toHaveLength(1);
    });

    it("supports insert with an explicit supersedes id in one transaction", () => {
      const first = insertRecord(tmp.db, decision());
      const second = insertRecord(tmp.db, decision({ title: "Updated", supersedes: first.id }));
      const old = getRecord(tmp.db, first.id, { includeSuperseded: true });
      expect(old?.supersededBy).toBe(second.id);
    });
  });

  describe("read scoping (SPEC §3.4)", () => {
    it("lists own-project records plus global records, never other projects", () => {
      insertRecord(tmp.db, decision({ title: "Mine" }));
      insertRecord(tmp.db, decision({ projectId: "other-project", title: "Theirs" }));
      insertRecord(
        tmp.db,
        decision({
          projectId: "_global",
          type: "preference",
          scope: "global",
          title: "Global preference",
        }),
      );

      const titles = listRecords(tmp.db, PROJECT).map((r) => r.title);
      expect(titles).toContain("Mine");
      expect(titles).toContain("Global preference");
      expect(titles).not.toContain("Theirs");
    });
  });

  describe("rule-based supersession for keyed types (SPEC §3.5)", () => {
    it("keeps exactly one current handover per project", () => {
      const h1 = insertRecord(
        tmp.db,
        decision({ type: "handover", title: "Handover 1", body: "wip" }),
      );
      const h2 = insertRecord(
        tmp.db,
        decision({ type: "handover", title: "Handover 2", body: "wip 2" }),
      );

      const current = listRecords(tmp.db, PROJECT, { type: "handover" });
      expect(current.map((r) => r.id)).toEqual([h2.id]);
      expect(getRecord(tmp.db, h1.id, { includeSuperseded: true })?.supersededBy).toBe(h2.id);

      // Other projects are unaffected.
      const other = insertRecord(
        tmp.db,
        decision({ projectId: "other", type: "handover", title: "Other", body: "x" }),
      );
      expect(listRecords(tmp.db, PROJECT, { type: "handover" })).toHaveLength(1);
      expect(getRecord(tmp.db, other.id)).not.toBeNull();
    });

    it("supersedes profile records per title key", () => {
      const cmd1 = insertRecord(
        tmp.db,
        decision({ type: "profile", title: "test_command", body: "npm test" }),
      );
      insertRecord(
        tmp.db,
        decision({ type: "profile", title: "build_command", body: "npm run build" }),
      );
      const cmd2 = insertRecord(
        tmp.db,
        decision({ type: "profile", title: "test_command", body: "vitest run" }),
      );

      const current = listRecords(tmp.db, PROJECT, { type: "profile" });
      expect(current).toHaveLength(2);
      expect(getRecord(tmp.db, cmd1.id, { includeSuperseded: true })?.supersededBy).toBe(cmd2.id);
    });
  });
});
