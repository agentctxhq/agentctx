import type { Database } from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../../src/config.js";
import { runConsolidate } from "../../src/consolidate/run.js";
import { ingestExtraction } from "../../src/extract/ingest.js";
import type { ExtractionResult } from "../../src/extract/schema.js";
import {
  SESSION_START_MAX_TOKENS,
  digestFilePath,
  readDigestFile,
} from "../../src/hooks/digest.js";
import { estimateTokens } from "../../src/hooks/tokens.js";
import { openDatabase } from "../../src/storage/db.js";
import { getRecord, insertRecord } from "../../src/storage/records.js";
import { GLOBAL_PROJECT_ID, type NewRecord } from "../../src/storage/types.js";
import { type TestEnv, makeTestEnv } from "../cli/helpers.js";

const PROJECT = "proj-a";

function emptyExtraction(overrides: Partial<ExtractionResult> = {}): ExtractionResult {
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

describe("agentctx consolidate", () => {
  let t: TestEnv;

  beforeEach(() => {
    t = makeTestEnv();
  });

  afterEach(() => t.cleanup());

  function seed(record: Omit<NewRecord, "projectId" | "source"> & { projectId?: string }): string {
    const db = openDatabase(t.env.dbPath);
    try {
      const { projectId, ...rest } = record;
      return insertRecord(db, {
        projectId: projectId ?? PROJECT,
        source: "llm_extraction",
        ...rest,
      }).id;
    } finally {
      db.close();
    }
  }

  function withDb<T>(fn: (db: Database) => T): T {
    const db = openDatabase(t.env.dbPath);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  it("exits cleanly when no database exists", async () => {
    expect(await runConsolidate(t.env)).toBe(0);
  });

  it("upgrades inferred records at the reinforce threshold (SPEC §3.3)", async () => {
    const reached = seed({ type: "preference", title: "A", body: "a", confidence: "inferred" });
    const notYet = seed({ type: "preference", title: "B", body: "b", confidence: "inferred" });
    withDb((db) => db.prepare("UPDATE records SET reinforce_count = 2 WHERE id = ?").run(reached));

    expect(await runConsolidate(t.env)).toBe(0);

    withDb((db) => {
      expect(getRecord(db, reached)?.confidence).toBe("reinforced"); // 3 sessions, default N=3
      expect(getRecord(db, notYet)?.confidence).toBe("inferred");
    });
  });

  it("honors a configured reinforceThreshold", async () => {
    saveConfig(t.env.configPath, { reinforceThreshold: 2 });
    const id = seed({ type: "preference", title: "A", body: "a", confidence: "inferred" });
    withDb((db) => db.prepare("UPDATE records SET reinforce_count = 1 WHERE id = ?").run(id));

    await runConsolidate(t.env);
    withDb((db) => expect(getRecord(db, id)?.confidence).toBe("reinforced"));
  });

  it("applies recency-only score decay per type lifecycle (SPEC §3.2)", async () => {
    const decision = seed({ type: "decision", title: "D", body: "d" });
    const oldDiscovery = seed({ type: "discovery", title: "Old", body: "o" });
    const pinned = seed({ type: "discovery", title: "Pin", body: "p", pinned: true });
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString();
    withDb((db) =>
      db
        .prepare("UPDATE records SET recorded_at = ? WHERE id IN (?, ?)")
        .run(sixtyDaysAgo, oldDiscovery, pinned),
    );

    await runConsolidate(t.env);

    withDb((db) => {
      expect(getRecord(db, decision)?.score).toBe(1.0); // decisions never decay
      const decayed = getRecord(db, oldDiscovery)?.score ?? 1;
      expect(decayed).toBeCloseTo(0.25, 2); // two 30-day half-lives
      expect(getRecord(db, pinned)?.score).toBe(1.0);
    });
  });

  it("leaves pending_embedding untouched (v0.2 surface)", async () => {
    const id = seed({ type: "decision", title: "D", body: "d" });
    await runConsolidate(t.env);
    withDb((db) => expect(getRecord(db, id)?.pendingEmbedding).toBe(true));
  });

  describe("digest pre-compute (SPEC §4)", () => {
    it("writes a budget-composed digest per project", async () => {
      seed({ type: "profile", title: "Stack", body: "TypeScript, ESM", confidence: "explicit" });
      seed({ type: "decision", title: "Use SQLite", body: "No daemon", confidence: "explicit" });
      seed({
        type: "decision",
        title: "Inferred guess",
        body: "should not appear",
        confidence: "inferred",
      });
      seed({
        type: "handover",
        title: "Handover: extraction",
        body: "Current task: extraction pipeline",
        confidence: "explicit",
      });
      seed({
        projectId: GLOBAL_PROJECT_ID,
        scope: "global",
        type: "preference",
        title: "Prefers arrow functions",
        body: "arrow functions",
        confidence: "reinforced",
      });
      seed({
        projectId: GLOBAL_PROJECT_ID,
        scope: "global",
        type: "preference",
        title: "Unproven inferred preference",
        body: "not yet reinforced",
        confidence: "inferred",
      });

      expect(await runConsolidate(t.env)).toBe(0);

      const digest = readDigestFile(digestFilePath(t.env.agentctxHome, PROJECT));
      expect(digest).not.toBeNull();
      expect(digest?.projectId).toBe(PROJECT);
      expect(digest?.sections.profile).toContain("Stack: TypeScript, ESM");
      expect(digest?.sections.decisions).toContain("Use SQLite");
      expect(digest?.sections.decisions).not.toContain("Inferred guess"); // SPEC §7
      expect(digest?.sections.handover).toContain("extraction pipeline");
      expect(digest?.sections.globalPreferences).toContain("Prefers arrow functions");
      expect(digest?.sections.globalPreferences).not.toContain("Unproven");
      expect(digest?.sections.mcpHint).toContain("ctx_search");

      const total = Object.values(digest?.sections ?? {}).reduce(
        (sum, section) => sum + estimateTokens(section),
        0,
      );
      expect(total).toBeLessThanOrEqual(SESSION_START_MAX_TOKENS);
    });

    it("labels an inferred handover as unconfirmed", async () => {
      seed({
        type: "handover",
        title: "Handover: pre-compact snapshot",
        body: "Last prompt before compaction",
        confidence: "inferred",
      });
      await runConsolidate(t.env);
      const digest = readDigestFile(digestFilePath(t.env.agentctxHome, PROJECT));
      expect(digest?.sections.handover).toContain("(unconfirmed)");
    });

    it("does not repeat extracted decision text in digest lines", async () => {
      withDb((db) => {
        ingestExtraction(
          db,
          PROJECT,
          "s1",
          emptyExtraction({
            decisions: [
              {
                what: "Use SQLite for storage",
                rationale: "No daemon",
                supersedes: null,
                confidence: "explicit",
              },
            ],
          }),
          () => {},
        );
      });

      await runConsolidate(t.env);
      const digest = readDigestFile(digestFilePath(t.env.agentctxHome, PROJECT));
      expect(digest?.sections.decisions).toContain(
        "- Use SQLite for storage: Rationale: No daemon",
      );
      expect(digest?.sections.decisions).not.toContain(
        "Use SQLite for storage: Use SQLite for storage",
      );
    });

    it("keeps distinct manual decision title/body details in digest lines", async () => {
      seed({ type: "decision", title: "Use SQLite", body: "No daemon", confidence: "explicit" });

      await runConsolidate(t.env);
      const digest = readDigestFile(digestFilePath(t.env.agentctxHome, PROJECT));
      expect(digest?.sections.decisions).toContain("- Use SQLite: No daemon");
    });

    it("truncates each section to its build budget", async () => {
      for (let i = 0; i < 50; i++) {
        seed({
          type: "decision",
          title: `Decision number ${i}`,
          body: "long rationale ".repeat(30),
          confidence: "explicit",
        });
      }
      await runConsolidate(t.env);
      const digest = readDigestFile(digestFilePath(t.env.agentctxHome, PROJECT));
      expect(estimateTokens(digest?.sections.decisions ?? "")).toBeLessThanOrEqual(500);
    });
  });
});
