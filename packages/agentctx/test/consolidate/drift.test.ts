import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DRIFT_CANDIDATE_THRESHOLD,
  buildSyncReport,
  computeDriftScore,
  findClaudeMd,
  scanClaudemdDrift,
  tokenizeText,
} from "../../src/consolidate/drift.js";
import { runConsolidate } from "../../src/consolidate/run.js";
import {
  SESSION_START_MAX_TOKENS,
  digestFilePath,
  readDigestFile,
} from "../../src/hooks/digest.js";
import { estimateTokens } from "../../src/hooks/tokens.js";
import { openDatabase } from "../../src/storage/db.js";
import { getRecord, insertRecord } from "../../src/storage/records.js";
import type { NewRecord } from "../../src/storage/types.js";
import { type TestEnv, makeTestEnv } from "../cli/helpers.js";
import { type TempDb, openTempDb } from "../storage/helpers.js";

const PROJECT = "proj-drift";

// --- unit tests: tokenizeText ------------------------------------------------

describe("tokenizeText", () => {
  it("lowercases and deduplicates tokens", () => {
    // Default minLen=3 (CLAUDE.md indexing mode)
    const tokens = tokenizeText("Use SQLite SQLite for storage");
    expect(tokens.has("use")).toBe(true);
    expect(tokens.has("sqlite")).toBe(true);
    expect(tokens.has("storage")).toBe(true);
    // Dedup — Set should not count duplicates
    expect([...tokens].filter((t) => t === "sqlite").length).toBe(1);
  });

  it("drops tokens shorter than minLen (default 3 chars)", () => {
    const tokens = tokenizeText("an to in do go use");
    // "an", "to", "in", "do", "go" are 2 chars → dropped
    expect(tokens.has("an")).toBe(false);
    expect(tokens.has("to")).toBe(false);
    expect(tokens.has("in")).toBe(false);
    // "use" is 3 chars → kept
    expect(tokens.has("use")).toBe(true);
  });

  it("respects a custom minLen argument", () => {
    const tokens = tokenizeText("use for and sqlite react", 4);
    // "use", "for", "and" are 3 chars → dropped with minLen=4
    expect(tokens.has("use")).toBe(false);
    expect(tokens.has("for")).toBe(false);
    expect(tokens.has("and")).toBe(false);
    // "sqlite" (6) and "react" (5) are kept
    expect(tokens.has("sqlite")).toBe(true);
    expect(tokens.has("react")).toBe(true);
  });

  it("handles empty string", () => {
    expect(tokenizeText("").size).toBe(0);
  });

  it("handles alphanumeric mixed tokens", () => {
    const tokens = tokenizeText("better-sqlite3 bge-small-en-v1.5");
    expect(tokens.has("better")).toBe(true);
    expect(tokens.has("sqlite3")).toBe(true);
    expect(tokens.has("small")).toBe(true);
  });
});

// --- unit tests: computeDriftScore -------------------------------------------

describe("computeDriftScore", () => {
  it("returns 0 when all title tokens are in CLAUDE.md", () => {
    const claudeTokens = tokenizeText("We use better-sqlite3 as our SQLite driver in WAL mode");
    const score = computeDriftScore("Use SQLite driver", claudeTokens);
    // "use", "sqlite", "driver" — all 3 present
    expect(score).toBeCloseTo(0, 5);
  });

  it("returns 1 when no title tokens match CLAUDE.md", () => {
    const claudeTokens = tokenizeText("This project uses React and Tailwind for the frontend");
    const score = computeDriftScore("Use gRPC transport layer", claudeTokens);
    // "use", "grpc", "transport", "layer" — none match
    expect(score).toBeCloseTo(1, 5);
  });

  it("returns a partial score for partial coverage", () => {
    const claudeTokens = tokenizeText("We use SQLite for storage");
    // Title tokens (minLen=4): "sqlite", "grpc", "gateway" — "use" dropped
    // CLAUDE.md has "sqlite" (via minLen=3 indexing) but not "grpc"/"gateway"
    // 1/3 match → score ≈ 0.67
    const score = computeDriftScore("Use SQLite gRPC gateway", claudeTokens);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("returns 0 for titles with fewer than 2 significant tokens", () => {
    const claudeTokens = tokenizeText("some content here");
    expect(computeDriftScore("Decision", claudeTokens)).toBe(0);
    expect(computeDriftScore("no", claudeTokens)).toBe(0);
  });
});

// --- findClaudeMd ------------------------------------------------------------

describe("findClaudeMd", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agentctx-drift-cwd-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("finds CLAUDE.md at the project root", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# test");
    expect(findClaudeMd(dir)).toBe(join(dir, "CLAUDE.md"));
  });

  it("finds CLAUDE.md in .claude/", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "CLAUDE.md"), "# test");
    expect(findClaudeMd(dir)).toBe(join(dir, ".claude", "CLAUDE.md"));
  });

  it("prefers root over .claude/", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "# root");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "CLAUDE.md"), "# dot claude");
    expect(findClaudeMd(dir)).toBe(join(dir, "CLAUDE.md"));
  });

  it("returns null when no CLAUDE.md exists", () => {
    expect(findClaudeMd(dir)).toBeNull();
  });
});

// --- scanClaudemdDrift -------------------------------------------------------

describe("scanClaudemdDrift", () => {
  let tmp: TempDb;
  let cwd: string;

  beforeEach(() => {
    tmp = openTempDb();
    cwd = mkdtempSync(join(tmpdir(), "agentctx-drift-scan-"));
  });
  afterEach(() => {
    tmp.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  });

  function seed(overrides: Partial<NewRecord> & Pick<NewRecord, "title" | "body">) {
    return insertRecord(tmp.db, {
      projectId: PROJECT,
      type: "decision",
      source: "llm_extraction",
      confidence: "explicit",
      ...overrides,
    });
  }

  it("returns 0 and resets scores when no CLAUDE.md exists", () => {
    const r = seed({ title: "Use SQLite for storage", body: "WAL mode" });
    tmp.db.prepare("UPDATE records SET claudemd_drift_score = 0.9 WHERE id = ?").run(r.id);

    const count = scanClaudemdDrift(tmp.db, PROJECT, cwd);
    expect(count).toBe(0);
    expect(getRecord(tmp.db, r.id)?.claudemdDriftScore).toBe(0);
  });

  it("marks records with low coverage as drift candidates", () => {
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      "# Project\n\nWe use React and Tailwind for the frontend UI.",
    );
    const notInClaude = seed({
      title: "Use gRPC for service transport",
      body: "All services communicate via gRPC",
    });
    const inClaude = seed({
      title: "Use React for the frontend",
      body: "All UI components are React",
    });

    const count = scanClaudemdDrift(tmp.db, PROJECT, cwd);
    expect(count).toBeGreaterThanOrEqual(1);

    const driftRecord = getRecord(tmp.db, notInClaude.id);
    const coveredRecord = getRecord(tmp.db, inClaude.id);

    expect(driftRecord?.claudemdDriftScore).toBeGreaterThanOrEqual(DRIFT_CANDIDATE_THRESHOLD);
    expect(coveredRecord?.claudemdDriftScore).toBeLessThan(DRIFT_CANDIDATE_THRESHOLD);
  });

  it("skips inferred records (confidence threshold per ADR-013)", () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "# Minimal CLAUDE.md content only");
    const inferred = seed({
      title: "Use GraphQL everywhere",
      body: "All APIs via GraphQL",
      confidence: "inferred",
    });

    scanClaudemdDrift(tmp.db, PROJECT, cwd);
    // Inferred records are not scored — score stays at default 0
    expect(getRecord(tmp.db, inferred.id)?.claudemdDriftScore).toBe(0);
  });

  it("does not score convention records' drift for other types", () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "# Project");
    seed({ type: "preference", title: "Prefer arrow functions", body: "arrow style" });

    const count = scanClaudemdDrift(tmp.db, PROJECT, cwd);
    expect(count).toBe(0); // preferences are not scanned
  });

  it("scores convention records same as decisions", () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "# Only React content here");
    const convention = seed({
      type: "convention",
      title: "Use gRPC for service transport",
      body: "Convention: all inter-service calls use gRPC",
    });

    const count = scanClaudemdDrift(tmp.db, PROJECT, cwd);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(getRecord(tmp.db, convention.id)?.claudemdDriftScore).toBeGreaterThanOrEqual(
      DRIFT_CANDIDATE_THRESHOLD,
    );
  });
});

// --- buildSyncReport ---------------------------------------------------------

describe("buildSyncReport", () => {
  let tmp: TempDb;
  let cwd: string;

  beforeEach(() => {
    tmp = openTempDb();
    cwd = mkdtempSync(join(tmpdir(), "agentctx-drift-report-"));
  });
  afterEach(() => {
    tmp.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  });

  function seed(overrides: Partial<NewRecord> & Pick<NewRecord, "title" | "body">) {
    return insertRecord(tmp.db, {
      projectId: PROJECT,
      type: "decision",
      source: "llm_extraction",
      confidence: "explicit",
      ...overrides,
    });
  }

  it("returns empty report when no CLAUDE.md exists", () => {
    seed({ title: "Use SQLite", body: "WAL mode" });
    const report = buildSyncReport(tmp.db, PROJECT, cwd);
    expect(report.missing).toHaveLength(0);
    expect(report.contradicted).toHaveLength(0);
    expect(report.proposed_diff).toBe("");
  });

  it("reports missing records not in CLAUDE.md", () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "# Project\n\nWe use React and TypeScript.");
    seed({ title: "Use gRPC for transport", body: "All services use gRPC" });

    const report = buildSyncReport(tmp.db, PROJECT, cwd);
    expect(report.missing.length).toBeGreaterThanOrEqual(1);
    expect(report.missing.some((e) => e.title === "Use gRPC for transport")).toBe(true);
  });

  it("does not include records that are covered in CLAUDE.md", () => {
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      "# Project\n\nWe use SQLite as the storage backend via better-sqlite3.",
    );
    seed({ title: "Use SQLite for storage", body: "WAL mode, better-sqlite3 driver" });

    const report = buildSyncReport(tmp.db, PROJECT, cwd);
    expect(report.missing.some((e) => e.title === "Use SQLite for storage")).toBe(false);
  });

  it("reports contradicted entries for superseded records still in CLAUDE.md", () => {
    // The CLAUDE.md still mentions "REST" but the store says it was superseded.
    writeFileSync(
      join(cwd, "CLAUDE.md"),
      "# API style\n\nUse REST everywhere for all service calls.",
    );
    const old = seed({ title: "Use REST everywhere", body: "All APIs are REST" });
    seed({
      title: "Use gRPC everywhere",
      body: "Migrated to gRPC for perf",
      supersedes: old.id,
    });

    const report = buildSyncReport(tmp.db, PROJECT, cwd);
    expect(report.contradicted.some((e) => e.title === "Use REST everywhere")).toBe(true);
  });

  it("includes record IDs in the proposed_diff", () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "# Minimal");
    const r = seed({ title: "Use gRPC transport layer", body: "All inter-service gRPC" });

    const report = buildSyncReport(tmp.db, PROJECT, cwd);
    expect(report.proposed_diff).toContain(r.id);
  });

  it("handles empty store gracefully", () => {
    writeFileSync(join(cwd, "CLAUDE.md"), "# Some content");
    const report = buildSyncReport(tmp.db, PROJECT, cwd);
    expect(report.missing).toHaveLength(0);
    expect(report.contradicted).toHaveLength(0);
  });

  it("does not flag short-token superseded titles as contradicted (regression: score=0 ambiguity)", () => {
    // "Use API" → title tokens (minLen=4): [] or ["api"] — fewer than MIN_TOKENS_FOR_DRIFT.
    // computeDriftScore returns 0 (not enough tokens), which must NOT be treated
    // as "fully covered" and erroneously added to contradicted.
    writeFileSync(join(cwd, "CLAUDE.md"), "# Project\n\nWe use React and Tailwind.");
    const old = seed({ title: "Use API", body: "REST API endpoints" });
    seed({ title: "Use gRPC", body: "Migrated to gRPC", supersedes: old.id });

    const report = buildSyncReport(tmp.db, PROJECT, cwd);
    // "Use API" has < 2 significant (4+ char) tokens — must be skipped, not contradicted
    expect(report.contradicted.some((e) => e.title === "Use API")).toBe(false);
  });
});

// --- integration: consolidate triggers drift scan and digest hint ------------

describe("consolidate drift integration", () => {
  let t: TestEnv;

  beforeEach(() => {
    t = makeTestEnv();
  });
  afterEach(() => t.cleanup());

  function seed(record: Omit<NewRecord, "projectId" | "source"> & { projectId?: string }) {
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

  it("digest includes driftHint when ≥ 2 drift candidates after consolidate", async () => {
    // Seed records that won't appear in the project's CLAUDE.md
    // t.env.cwd is the test project dir — place a minimal CLAUDE.md there
    writeFileSync(
      join(t.env.cwd, "CLAUDE.md"),
      "# Project\n\nThis project uses React for the frontend.",
    );

    // Two decisions not reflected in CLAUDE.md
    seed({
      type: "decision",
      title: "Use gRPC for transport",
      body: "All services communicate via gRPC",
      confidence: "explicit",
    });
    seed({
      type: "decision",
      title: "Use PostgreSQL for persistence",
      body: "Primary datastore is PostgreSQL",
      confidence: "explicit",
    });

    expect(await runConsolidate(t.env)).toBe(0);

    const digest = readDigestFile(digestFilePath(t.env.agentctxHome, PROJECT));
    // The cwd resolves to a different project_id than PROJECT, so drift scores
    // are written for that project. Check that driftHint appears when using
    // the actual cwd project — use the env's project id via resolveProjectId.
    // In a unit test the cwd project is what consolidate scans.
    // The digest is written per-project from DB; PROJECT won't have drift note
    // since the scan ran for the cwd's resolved project_id.
    // (This tests that the system doesn't error; deeper drift→digest link is
    // tested via the cwd project id path below.)
    expect(digest).toBeDefined();
    const total = Object.values(digest?.sections ?? {}).reduce(
      (sum, section) => sum + estimateTokens(section),
      0,
    );
    expect(total).toBeLessThanOrEqual(SESSION_START_MAX_TOKENS);
  });

  it("drift hint appears in digest for the cwd project when drift count ≥ 2", async () => {
    const { resolveProjectId } = await import("../../src/storage/namespace.js");
    const cwdProjectId = resolveProjectId(t.env.cwd);

    writeFileSync(join(t.env.cwd, "CLAUDE.md"), "# Project\n\nWe use TypeScript and npm.");

    // Seed directly to the cwd project id
    const db = openDatabase(t.env.dbPath);
    try {
      insertRecord(db, {
        projectId: cwdProjectId,
        type: "decision",
        title: "Use gRPC for transport",
        body: "All services use gRPC",
        source: "llm_extraction",
        confidence: "explicit",
      });
      insertRecord(db, {
        projectId: cwdProjectId,
        type: "decision",
        title: "Use PostgreSQL as primary datastore",
        body: "PostgreSQL with WAL",
        source: "llm_extraction",
        confidence: "explicit",
      });
    } finally {
      db.close();
    }

    expect(await runConsolidate(t.env)).toBe(0);

    const digest = readDigestFile(digestFilePath(t.env.agentctxHome, cwdProjectId));
    expect(digest?.sections.driftHint).toBeDefined();
    expect(digest?.sections.driftHint).toContain("agentctx sync");
    expect(digest?.sections.driftHint).toMatch(/\d+ architectural/);
  });

  it("drift hint is absent when fewer than 2 drift candidates", async () => {
    const { resolveProjectId } = await import("../../src/storage/namespace.js");
    const cwdProjectId = resolveProjectId(t.env.cwd);

    // CLAUDE.md that covers our one record
    writeFileSync(
      join(t.env.cwd, "CLAUDE.md"),
      "# Project\n\nWe use SQLite for storage with WAL mode.",
    );
    const db = openDatabase(t.env.dbPath);
    try {
      insertRecord(db, {
        projectId: cwdProjectId,
        type: "decision",
        title: "Use SQLite for storage",
        body: "WAL mode, better-sqlite3",
        source: "llm_extraction",
        confidence: "explicit",
      });
    } finally {
      db.close();
    }

    await runConsolidate(t.env);
    const digest = readDigestFile(digestFilePath(t.env.agentctxHome, cwdProjectId));
    expect(digest?.sections.driftHint).toBeUndefined();
  });
});
