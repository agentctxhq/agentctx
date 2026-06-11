/**
 * CLAUDE.md drift detection and sync report (ADR-013, SPEC §4, §5).
 *
 * Detection: for each active non-inferred decision/convention record, compute
 * how well its title is covered by the CLAUDE.md word set using token overlap
 * (FTS5-style BM25 tokenization). High score = not reflected in CLAUDE.md.
 *
 * Sync report: structured {missing, contradicted, proposed_diff} consumed by
 * both ctx_sync_claudemd() and `agentctx sync`. Computed fresh on demand —
 * the stored claudemd_drift_score is derived data (SPEC §7) used only for the
 * SessionStart digest hint.
 *
 * Invariant 5 (SPEC §1): writes to CLAUDE.md are always a human action; this
 * module only reads CLAUDE.md and writes claudemd_drift_score to the DB.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { rowToRecord } from "../storage/records.js";

/** Score >= this threshold: the record is a drift candidate. */
export const DRIFT_CANDIDATE_THRESHOLD = 0.7;

/** Score < this: the title is still prominently in CLAUDE.md (contradicted). */
const CONTRADICTED_COVERAGE_THRESHOLD = 0.5;

/** Minimum significant tokens in a title before scoring (avoids single-word noise). */
const MIN_TOKENS_FOR_DRIFT = 2;

/**
 * Minimum char length for title tokens. Higher than CLAUDE.md (3) to skip
 * common English function words ("use", "for", "and", "the") that would
 * inflate coverage scores and mask real drift.
 */
const TITLE_MIN_TOKEN_LEN = 4;

/**
 * Locate CLAUDE.md: project root first, then `.claude/CLAUDE.md`.
 * Returns null if neither exists.
 */
export function findClaudeMd(cwd: string): string | null {
  const root = join(cwd, "CLAUDE.md");
  if (existsSync(root)) return root;
  const dotClaude = join(cwd, ".claude", "CLAUDE.md");
  if (existsSync(dotClaude)) return dotClaude;
  return null;
}

/**
 * Tokenize text into a normalised lowercase word set.
 * Matches alphanumeric/underscore runs; drops tokens shorter than `minLen` chars.
 * Default minLen=3 matches the FTS5 default — use when tokenizing CLAUDE.md.
 * Use minLen=4 for record titles to skip common English function words.
 */
export function tokenizeText(text: string, minLen = 3): Set<string> {
  const matches = text.match(/[a-zA-Z0-9_]+/g) ?? [];
  const result = new Set<string>();
  for (const m of matches) {
    const lower = m.toLowerCase();
    if (lower.length >= minLen) {
      result.add(lower);
    }
  }
  return result;
}

/**
 * Drift score for one record title against a CLAUDE.md token set.
 * Returns `1 - coverage` where coverage = fraction of title tokens found.
 * Returns 0 when the title has too few tokens to evaluate (avoids noise).
 */
export function computeDriftScore(title: string, claudeTokens: Set<string>): number {
  // 4-char minimum for title tokens skips English function words ("use",
  // "for", "and") that inflate coverage scores when they appear in both
  // the title and CLAUDE.md, masking genuinely uncovered concepts.
  const tokens = [...tokenizeText(title, TITLE_MIN_TOKEN_LEN)];
  if (tokens.length < MIN_TOKENS_FOR_DRIFT) {
    return 0;
  }
  const matched = tokens.filter((t) => claudeTokens.has(t)).length;
  return 1 - matched / tokens.length;
}

/**
 * Update `claudemd_drift_score` for all active decision/convention records in
 * the given project. Returns the count of drift candidates (score ≥ threshold).
 *
 * No CLAUDE.md → reset all scores to 0 (nothing to compare against).
 * Empty store → 0 returned.
 */
export function scanClaudemdDrift(db: Database, projectId: string, cwd: string): number {
  const claudeMdPath = findClaudeMd(cwd);

  if (claudeMdPath === null) {
    db.prepare(
      `UPDATE records SET claudemd_drift_score = 0
       WHERE project_id = ? AND superseded_at IS NULL
         AND type IN ('decision', 'convention')`,
    ).run(projectId);
    return 0;
  }

  let claudeContent: string;
  try {
    claudeContent = readFileSync(claudeMdPath, "utf8");
  } catch {
    // File disappeared between existsSync and read — degrade silently.
    return 0;
  }
  const claudeTokens = tokenizeText(claudeContent);

  // Only score non-inferred records (ADR-013: confidence threshold to limit
  // false positives; inferred records haven't been confirmed yet).
  const rows = db
    .prepare(
      `SELECT * FROM records
       WHERE project_id = @projectId
         AND superseded_at IS NULL
         AND type IN ('decision', 'convention')
         AND confidence != 'inferred'`,
    )
    .all({ projectId }) as Array<Parameters<typeof rowToRecord>[0]>;

  if (rows.length === 0) return 0;

  const update = db.prepare("UPDATE records SET claudemd_drift_score = ? WHERE id = ?");
  let driftCount = 0;

  db.transaction(() => {
    for (const row of rows) {
      const score = computeDriftScore(row.title, claudeTokens);
      update.run(score, row.id);
      if (score >= DRIFT_CANDIDATE_THRESHOLD) {
        driftCount++;
      }
    }
  })();

  return driftCount;
}

// --- Sync report (shared by ctx_sync_claudemd and agentctx sync) -------------

export interface DriftEntry {
  id: string;
  type: string;
  title: string;
  body: string;
}

export interface ContradictedEntry {
  id: string;
  type: string;
  title: string;
  superseded_by: string | null;
}

export interface SyncReport {
  missing: DriftEntry[];
  contradicted: ContradictedEntry[];
  proposed_diff: string;
}

/**
 * Build a fresh sync report without touching DB drift scores.
 * Returns {missing, contradicted, proposed_diff} referencing record IDs.
 *
 * missing: active records not reflected in CLAUDE.md (drift score ≥ threshold).
 * contradicted: superseded records whose title tokens still appear in CLAUDE.md
 *   (the store says the fact changed, but CLAUDE.md may still have the old text).
 */
export function buildSyncReport(db: Database, projectId: string, cwd: string): SyncReport {
  const claudeMdPath = findClaudeMd(cwd);
  if (claudeMdPath === null) {
    return { missing: [], contradicted: [], proposed_diff: "" };
  }

  let claudeContent: string;
  try {
    claudeContent = readFileSync(claudeMdPath, "utf8");
  } catch {
    return { missing: [], contradicted: [], proposed_diff: "" };
  }
  const claudeTokens = tokenizeText(claudeContent);

  // missing: active non-inferred decisions/conventions with high drift score
  const activeRows = db
    .prepare(
      `SELECT * FROM records
       WHERE project_id = @projectId
         AND superseded_at IS NULL
         AND type IN ('decision', 'convention')
         AND confidence != 'inferred'
       ORDER BY type, score DESC
       LIMIT 20`,
    )
    .all({ projectId }) as Array<Parameters<typeof rowToRecord>[0]>;

  const missing: DriftEntry[] = [];
  for (const row of activeRows) {
    if (computeDriftScore(row.title, claudeTokens) >= DRIFT_CANDIDATE_THRESHOLD) {
      missing.push({ id: row.id, type: row.type, title: row.title, body: row.body });
    }
  }

  // contradicted: recently superseded records still present in CLAUDE.md
  const supersededRows = db
    .prepare(
      `SELECT * FROM records
       WHERE project_id = @projectId
         AND superseded_at IS NOT NULL
         AND type IN ('decision', 'convention')
       ORDER BY superseded_at DESC
       LIMIT 30`,
    )
    .all({ projectId }) as Array<Parameters<typeof rowToRecord>[0]>;

  const contradicted: ContradictedEntry[] = [];
  for (const row of supersededRows) {
    // Low drift score on a superseded record = its title tokens are still in
    // CLAUDE.md even though the store considers the fact outdated.
    if (computeDriftScore(row.title, claudeTokens) < CONTRADICTED_COVERAGE_THRESHOLD) {
      contradicted.push({
        id: row.id,
        type: row.type,
        title: row.title,
        superseded_by: row.superseded_by,
      });
    }
  }

  return {
    missing,
    contradicted,
    proposed_diff: buildProposedDiff(missing, contradicted),
  };
}

function buildProposedDiff(missing: DriftEntry[], contradicted: ContradictedEntry[]): string {
  if (missing.length === 0 && contradicted.length === 0) return "";

  const parts: string[] = [];

  if (missing.length > 0) {
    const byType = new Map<string, DriftEntry[]>();
    for (const entry of missing) {
      const group = byType.get(entry.type) ?? [];
      group.push(entry);
      byType.set(entry.type, group);
    }

    parts.push("## Add to CLAUDE.md (not currently reflected)\n");
    for (const [type, entries] of byType) {
      parts.push(`### ${capitalize(type)}s\n`);
      for (const entry of entries) {
        const firstLine = entry.body.split("\n")[0] ?? "";
        parts.push(`- **${entry.title}**`);
        if (firstLine.length > 0) {
          parts.push(`  ${firstLine}`);
        }
        parts.push(`  *(agentctx record: ${entry.id})*\n`);
      }
    }
  }

  if (contradicted.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push("## Review in CLAUDE.md (possibly superseded)\n");
    parts.push(
      "These records were superseded in the context store but their content may still appear in CLAUDE.md:\n",
    );
    for (const entry of contradicted) {
      parts.push(`- ~~${entry.title}~~ *(agentctx record: ${entry.id})*`);
    }
  }

  return parts.join("\n");
}

function capitalize(s: string): string {
  return s.length === 0 ? s : (s[0] as string).toUpperCase() + s.slice(1);
}
