/**
 * `agentctx consolidate` — the SessionEnd offline pass (SPEC §4, ADR-012),
 * v0.1 subset: no embeddings (records keep `pending_embedding = 1` for the
 * v0.2 backfill), no near-duplicate merge.
 *
 * Steps:
 *   1. Confidence lifecycle (SPEC §3.3): inferred records that re-appeared
 *      across enough sessions (reinforce_count, bumped at ingest) upgrade to
 *      reinforced. One-way; no downgrades.
 *   2. Score update — derived data (SPEC §7), v0.1 simple recency-only
 *      decay per type lifecycle (SPEC §3.2). Rebuildable, never the only
 *      place a fact lives.
 *   3. Pre-compute the SessionStart digest file per project (SPEC §4) —
 *      SessionStart never computes inline.
 *
 * Spawned detached by SessionEnd; failures are logged and exit 0.
 */
import { existsSync } from "node:fs";
import type { Database } from "better-sqlite3";
import type { CliEnv } from "../cli/env.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import { GLOBAL_PROJECT_ID, type RecordType } from "../storage/types.js";
import { buildDigestSections, writeDigest } from "./digest.js";
import { scanClaudemdDrift } from "./drift.js";

/**
 * Recency half-lives in days, per type lifecycle (SPEC §3.2). `null` means
 * the type never decays (superseded explicitly instead).
 */
const HALF_LIFE_DAYS: Record<RecordType, number | null> = {
  decision: null,
  convention: null,
  profile: null,
  preference: 180, // slow decay
  discovery: 30,
  bugfix: 30,
  handover: 7, // fast — one per project, superseded each session anyway
};

const SCORE_FLOOR = 0.05;

export async function runConsolidate(env: CliEnv, _args: string[] = []): Promise<number> {
  if (!existsSync(env.dbPath)) {
    return 0; // nothing to consolidate before init
  }
  try {
    const db = openDatabase(env.dbPath);
    try {
      consolidate(db, env, new Date());
    } finally {
      db.close();
    }
  } catch (error) {
    // Detached background pass: never escalate (SPEC §8 rung 5).
    env.io.err(`agentctx consolidate: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}

function consolidate(db: Database, env: CliEnv, now: Date): void {
  upgradeReinforced(db, reinforceThreshold(env));
  updateScores(db, now);
  // Drift scan for the current project only (SessionEnd fires in the project's
  // directory; other projects are scanned when their own SessionEnd fires).
  const currentProjectId = resolveProjectId(env.cwd);
  scanClaudemdDrift(db, currentProjectId, env.cwd);
  for (const projectId of projectIds(db)) {
    writeDigest(env.agentctxHome, projectId, buildDigestSections(db, projectId), now);
  }
}

/**
 * SPEC §3.3: `inferred → reinforced` after appearing across N sessions
 * (default 3). reinforce_count counts re-appearances, so first appearance
 * plus `count` re-appearances = `count + 1` sessions.
 */
function upgradeReinforced(db: Database, threshold: number): void {
  db.prepare(
    `UPDATE records SET confidence = 'reinforced'
     WHERE confidence = 'inferred' AND superseded_at IS NULL
       AND reinforce_count + 1 >= ?`,
  ).run(threshold);
}

/** v0.1 recency-only ranking: score = 2^(-age/halfLife), floored; pinned stay 1.0. */
function updateScores(db: Database, now: Date): void {
  const rows = db
    .prepare("SELECT id, type, recorded_at, pinned FROM records WHERE superseded_at IS NULL")
    .all() as Array<{ id: string; type: string; recorded_at: string; pinned: number }>;

  const update = db.prepare("UPDATE records SET score = ? WHERE id = ?");
  db.transaction(() => {
    for (const row of rows) {
      const halfLife = HALF_LIFE_DAYS[row.type as RecordType] ?? null;
      let score = 1.0;
      if (halfLife !== null && row.pinned === 0) {
        const ageDays = Math.max(now.getTime() - Date.parse(row.recorded_at), 0) / 86_400_000;
        score = Math.max(SCORE_FLOOR, 2 ** (-ageDays / halfLife));
      }
      update.run(score, row.id);
    }
  })();
}

/** Every project namespace with records, except the global one (no digest file for it). */
function projectIds(db: Database): string[] {
  const rows = db
    .prepare("SELECT DISTINCT project_id FROM records WHERE project_id != ?")
    .all(GLOBAL_PROJECT_ID) as Array<{ project_id: string }>;
  return rows.map((row) => row.project_id);
}

function reinforceThreshold(env: CliEnv): number {
  try {
    return loadConfig(env.configPath).reinforceThreshold;
  } catch {
    return 3;
  }
}
