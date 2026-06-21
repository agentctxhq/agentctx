import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ingestExtraction } from "../../src/extract/ingest.js";
import type { ExtractionResult } from "../../src/extract/schema.js";
import { openDatabase } from "../../src/storage/db.js";
import { insertRecord, listRecords } from "../../src/storage/records.js";
import { BODY_MAX_CHARS, GLOBAL_PROJECT_ID } from "../../src/storage/types.js";

const PROJECT = "test-project";

function emptyResult(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
  return {
    decisions: [],
    preferences: [],
    conventions: [],
    activeWork: null,
    gotchas: [],
    flushOk: false,
    droppedEntries: 0,
    ...overrides,
  };
}

describe("ingestExtraction (SPEC §6 ingest)", () => {
  let root: string;
  let db: Database;
  const noLog = () => {};

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentctx-ingest-"));
    db = openDatabase(join(root, "agentctx.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it("maps every category to its record type with llm_extraction provenance", () => {
    const stats = ingestExtraction(
      db,
      PROJECT,
      "s1",
      emptyResult({
        decisions: [
          { what: "Use SQLite", rationale: "No daemon", supersedes: null, confidence: "explicit" },
        ],
        preferences: [
          { category: "style", rule: "Arrow functions", confidence: "inferred", scope: "project" },
        ],
        conventions: [
          { scope: "project", convention: "Conventional Commits", confidence: "explicit" },
        ],
        gotchas: [{ pattern: "WAL needs cleanup", whyItMatters: "stale -wal files" }],
        activeWork: {
          currentTask: "Build extraction",
          blockers: [],
          nextSteps: ["tests"],
          openQuestions: [],
        },
      }),
      noLog,
    );

    expect(stats.written).toBe(5);
    const records = listRecords(db, PROJECT);
    const byType = new Map(records.map((r) => [r.type, r]));
    expect(byType.get("decision")?.body).toBe("Use SQLite\n\nRationale: No daemon");
    expect(byType.get("decision")?.confidence).toBe("explicit");
    expect(byType.get("preference")?.confidence).toBe("inferred");
    expect(byType.get("convention")?.title).toBe("Conventional Commits");
    expect(byType.get("discovery")?.body).toContain("Why it matters: stale -wal files");
    expect(byType.get("handover")?.confidence).toBe("explicit");
    expect(byType.get("handover")?.body).toContain("Next steps:\n- tests");
    for (const record of records) {
      expect(record.source).toBe("llm_extraction");
      expect(record.sessionId).toBe("s1");
    }
  });

  it("writes nothing when flush_ok is set", () => {
    const stats = ingestExtraction(
      db,
      PROJECT,
      "s1",
      emptyResult({
        flushOk: true,
        decisions: [{ what: "ignored", rationale: null, supersedes: null, confidence: "explicit" }],
      }),
      noLog,
    );
    expect(stats.written).toBe(0);
    expect(listRecords(db, PROJECT)).toHaveLength(0);
  });

  it("routes global preferences to the _global namespace (SPEC §3.4)", () => {
    ingestExtraction(
      db,
      PROJECT,
      "s1",
      emptyResult({
        preferences: [
          { category: "process", rule: "TDD always", confidence: "inferred", scope: "global" },
        ],
      }),
      noLog,
    );
    expect(listRecords(db, PROJECT)).toHaveLength(1); // visible via global read scope
    const global = listRecords(db, GLOBAL_PROJECT_ID);
    expect(global[0]?.projectId).toBe(GLOBAL_PROJECT_ID);
    expect(global[0]?.scope).toBe("global");
  });

  it("supersedes the previous handover (rule-keyed, SPEC §3.5)", () => {
    const work = (task: string) =>
      emptyResult({
        activeWork: { currentTask: task, blockers: [], nextSteps: [], openQuestions: [] },
      });
    ingestExtraction(db, PROJECT, "s1", work("first task"), noLog);
    ingestExtraction(db, PROJECT, "s2", work("second task"), noLog);
    const handovers = listRecords(db, PROJECT, { type: "handover" });
    expect(handovers).toHaveLength(1);
    expect(handovers[0]?.title).toContain("second task");
  });

  it("honors a valid supersedes id and ignores an invalid one", () => {
    const old = insertRecord(db, {
      projectId: PROJECT,
      type: "decision",
      title: "Use REST",
      body: "REST everywhere",
      source: "mcp_tool",
    });
    const logs: string[] = [];
    const stats = ingestExtraction(
      db,
      PROJECT,
      "s1",
      emptyResult({
        decisions: [
          { what: "Use gRPC", rationale: null, supersedes: old.id, confidence: "explicit" },
          { what: "Other call", rationale: null, supersedes: "no-such-id", confidence: "explicit" },
        ],
      }),
      (m) => logs.push(m),
    );
    expect(stats.written).toBe(2);
    const current = listRecords(db, PROJECT, { type: "decision" });
    expect(current.map((r) => r.title).sort()).toEqual(["Other call", "Use gRPC"]);
    expect(logs.some((m) => m.includes("no-such-id"))).toBe(true);
  });

  it("ignores a supersedes id from a different namespace", () => {
    const otherProjectOld = insertRecord(db, {
      projectId: "other-project",
      type: "decision",
      title: "Use REST",
      body: "REST everywhere",
      source: "mcp_tool",
    });
    const logs: string[] = [];
    const stats = ingestExtraction(
      db,
      PROJECT,
      "s1",
      emptyResult({
        decisions: [
          { what: "Use gRPC", rationale: null, supersedes: otherProjectOld.id, confidence: "explicit" },
        ],
      }),
      (m) => logs.push(m),
    );
    expect(stats.written).toBe(1);
    expect(logs.some((m) => m.includes(otherProjectOld.id))).toBe(true);
    
    // The other project's record should NOT be superseded
    const otherRecords = listRecords(db, "other-project", { type: "decision", includeSuperseded: true });
    expect(otherRecords[0]?.supersededAt).toBeNull();
  });

  it("drops oversized entries (SPEC §6)", () => {
    const stats = ingestExtraction(
      db,
      PROJECT,
      "s1",
      emptyResult({
        decisions: [
          {
            what: "x".repeat(BODY_MAX_CHARS + 1),
            rationale: null,
            supersedes: null,
            confidence: "explicit",
          },
        ],
      }),
      noLog,
    );
    expect(stats.written).toBe(0);
    expect(stats.dropped).toBe(1);
  });

  describe("verbatim duplicates and reinforcement (SPEC §3.3)", () => {
    const decision = emptyResult({
      decisions: [
        { what: "Use SQLite", rationale: "No daemon", supersedes: null, confidence: "inferred" },
      ],
    });

    it("drops a same-session duplicate without reinforcement", () => {
      ingestExtraction(db, PROJECT, "s1", decision, noLog);
      const stats = ingestExtraction(db, PROJECT, "s1", decision, noLog);
      expect(stats.written).toBe(0);
      expect(stats.dropped).toBe(1);
      expect(stats.reinforced).toBe(0);
      expect(listRecords(db, PROJECT)[0]?.reinforceCount).toBe(0);
    });

    it("bumps reinforce_count on a cross-session re-appearance", () => {
      ingestExtraction(db, PROJECT, "s1", decision, noLog);
      const stats = ingestExtraction(db, PROJECT, "s2", decision, noLog);
      expect(stats.reinforced).toBe(1);
      const record = listRecords(db, PROJECT)[0];
      expect(record?.reinforceCount).toBe(1);
      expect(record?.confidence).toBe("inferred"); // threshold transition is consolidate's job
    });

    it("upgrades inferred → reinforced on one explicit confirmation", () => {
      ingestExtraction(db, PROJECT, "s1", decision, noLog);
      const explicit = emptyResult({
        decisions: [
          { what: "Use SQLite", rationale: "No daemon", supersedes: null, confidence: "explicit" },
        ],
      });
      ingestExtraction(db, PROJECT, "s2", explicit, noLog);
      expect(listRecords(db, PROJECT)[0]?.confidence).toBe("reinforced");
    });
  });
});
