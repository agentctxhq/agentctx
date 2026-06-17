/**
 * SessionStart digest pre-compute (SPEC §4, ADR-012 step 4).
 *
 * Builds the per-project digest file that the SessionStart hook reads
 * verbatim. Composition order and the 1,500-token total cap live in
 * hooks/digest.ts (the shared contract); this module owns the per-section
 * content and the ~per-section budgets, honored at build time.
 *
 * Confidence rules (SPEC §3.3, §7): inferred records are excluded from the
 * digest — decisions must be explicit or reinforced; global preferences
 * must be reinforced (or explicit). The handover is working state and is
 * included regardless, but an inferred one is labeled as unconfirmed so it
 * is never presented as established fact.
 */
import type { Database } from "better-sqlite3";
import { writeJsonObject } from "../claude/json-file.js";
import { type DigestFile, type DigestSection, digestFilePath } from "../hooks/digest.js";
import { truncateToTokens } from "../hooks/tokens.js";
import { rowToRecord } from "../storage/records.js";
import type { ContextRecord } from "../storage/types.js";
import { GLOBAL_PROJECT_ID } from "../storage/types.js";
import { DRIFT_CANDIDATE_THRESHOLD } from "./drift.js";

/** Per-section build budgets (SPEC §4 digest composition). */
export const SECTION_BUDGET_TOKENS: Record<DigestSection, number> = {
  profile: 200,
  decisions: 500,
  handover: 400,
  globalPreferences: 200,
  mcpHint: 100,
  driftHint: 60,
};

const MAX_DIGEST_DECISIONS = 10;

export function buildDigestSections(
  db: Database,
  projectId: string,
): Partial<Record<DigestSection, string>> {
  const sections: Partial<Record<DigestSection, string>> = {};

  const profiles = currentRecords(db, projectId, "type = 'profile'", "recorded_at ASC");
  if (profiles.length > 0) {
    sections.profile = truncateToTokens(
      `Project profile (agentctx):\n${profiles.map((r) => `- ${r.title}: ${r.body}`).join("\n")}`,
      SECTION_BUDGET_TOKENS.profile,
    );
  }

  const decisions = currentRecords(
    db,
    projectId,
    "type = 'decision' AND confidence != 'inferred'",
    "score DESC, recorded_at DESC",
    MAX_DIGEST_DECISIONS,
  );
  if (decisions.length > 0) {
    sections.decisions = truncateToTokens(
      `Active decisions (agentctx):\n${decisions.map(decisionDigestLine).join("\n")}`,
      SECTION_BUDGET_TOKENS.decisions,
    );
  }

  const handover = currentRecords(db, projectId, "type = 'handover'", "recorded_at DESC", 1)[0];
  if (handover !== undefined) {
    const label = handover.confidence === "inferred" ? " (unconfirmed)" : "";
    sections.handover = truncateToTokens(
      `Last session handover${label} (agentctx, ${handover.recordedAt}):\n${handover.body}`,
      SECTION_BUDGET_TOKENS.handover,
    );
  }

  const prefs = currentRecords(
    db,
    GLOBAL_PROJECT_ID,
    "type = 'preference' AND confidence != 'inferred'",
    "score DESC, recorded_at DESC",
  );
  if (prefs.length > 0) {
    sections.globalPreferences = truncateToTokens(
      `Developer preferences (agentctx, reinforced):\n${prefs.map((r) => `- ${r.title}`).join("\n")}`,
      SECTION_BUDGET_TOKENS.globalPreferences,
    );
  }

  const total = recordCount(db, projectId);
  if (total > 0) {
    sections.mcpHint = truncateToTokens(
      `agentctx has ${total} context records for this project. For deeper context use the MCP tools: ctx_search(query) to find records, ctx_get(ids) for full content.`,
      SECTION_BUDGET_TOKENS.mcpHint,
    );
  }

  // ADR-013: include a one-line note when ≥ 2 drift candidates exist.
  const driftRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM records
       WHERE project_id = ? AND superseded_at IS NULL
         AND type IN ('decision', 'convention')
         AND claudemd_drift_score >= ?`,
    )
    .get(projectId, DRIFT_CANDIDATE_THRESHOLD) as { n: number };

  if (driftRow.n >= 2) {
    sections.driftHint = truncateToTokens(
      `${driftRow.n} architectural decisions in the context store are not reflected in CLAUDE.md — run 'agentctx sync' to review.`,
      SECTION_BUDGET_TOKENS.driftHint,
    );
  }

  return sections;
}

/** Write the digest file atomically where SessionStart will read it. */
export function writeDigest(
  agentctxHome: string,
  projectId: string,
  sections: Partial<Record<DigestSection, string>>,
  now: Date,
): void {
  const digest: DigestFile = {
    version: 1,
    projectId,
    generatedAt: now.toISOString(),
    sections,
  };
  writeJsonObject(digestFilePath(agentctxHome, projectId), { ...digest });
}

/**
 * `filter` and `order` are interpolated into the SQL — they MUST be
 * compile-time literals owned by this module, never user input or any
 * value read from the database.
 */
function currentRecords(
  db: Database,
  projectId: string,
  filter: string,
  order: string,
  limit = 100,
): ContextRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM records
       WHERE project_id = @projectId AND superseded_at IS NULL AND ${filter}
       ORDER BY ${order} LIMIT @limit`,
    )
    .all({ projectId, limit }) as Array<Parameters<typeof rowToRecord>[0]>;
  return rows.map(rowToRecord);
}

function recordCount(db: Database, projectId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM records WHERE project_id = ? AND superseded_at IS NULL")
    .get(projectId) as { n: number };
  return row.n;
}

function meaningfulLines(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function decisionDigestLine(record: ContextRecord): string {
  const [first, second] = meaningfulLines(record.body);
  const detail = first === record.title ? second : first;
  return detail === undefined ? `- ${record.title}` : `- ${record.title}: ${detail}`;
}
