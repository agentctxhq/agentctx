/**
 * `agentctx status` — what agentctx knows and what it costs.
 *
 * Self-accounting is normative (SPEC §9): every injection records its token
 * estimate and every extraction its API cost, so this command can report the
 * tax we impose — cumulative injected tokens and extraction spend — next to
 * the context summary. Numbers come straight from the `sessions` table.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId, shortProjectId } from "../storage/namespace.js";
import { GLOBAL_VISIBLE_SQL } from "../storage/records.js";
import { RECORD_TYPES } from "../storage/types.js";
import type { CliEnv } from "./env.js";

export const STATUS_USAGE = `Usage: agentctx status

Shows the current project's context summary, cumulative injection token
cost, and extraction cost to date.`;

interface SessionTotals {
  sessions: number;
  tokensInjected: number;
  extractionCostUsd: number;
  lastActivity: string | null;
}

export async function runStatus(env: CliEnv, args: string[]): Promise<number> {
  if (args.includes("--help")) {
    env.io.out(STATUS_USAGE);
    return 0;
  }
  // Strict parse: reject unknown flags/positionals (status takes none).
  parseArgs({ args, options: {} });

  if (!existsSync(env.dbPath)) {
    env.io.err("agentctx is not initialized — run `agentctx init` first");
    return 1;
  }

  const projectId = resolveProjectId(env.cwd);
  const db = openDatabase(env.dbPath);
  try {
    const counts = recordCounts(db, projectId);
    const superseded = supersededCount(db, projectId);
    const globalPrefs = globalPreferenceCount(db);
    const project = sessionTotals(db, projectId);
    const all = sessionTotals(db, null);
    const config = loadConfig(env.configPath);

    env.io.out(`agentctx status — project ${shortProjectId(projectId)} (${env.cwd})`);
    env.io.out("");
    env.io.out("Context records (active):");
    let total = 0;
    for (const type of RECORD_TYPES) {
      const n = counts.get(type) ?? 0;
      total += n;
      if (n > 0) {
        env.io.out(`  ${type.padEnd(12)} ${n}`);
      }
    }
    env.io.out(
      `  ${"total".padEnd(12)} ${total}${superseded > 0 ? `   (+${superseded} superseded, kept as history)` : ""}`,
    );
    env.io.out(`Global developer preferences: ${globalPrefs} active`);
    env.io.out("");
    env.io.out(
      `Sessions: ${project.sessions}${
        project.lastActivity === null ? "" : ` (last activity ${project.lastActivity})`
      }`,
    );
    env.io.out(`Injection cost to date:  ${project.tokensInjected} tokens injected`);
    env.io.out(`Extraction cost to date: $${project.extractionCostUsd.toFixed(4)}`);
    env.io.out("");
    env.io.out(
      `All projects: ${all.sessions} session(s), ${all.tokensInjected} tokens injected, ` +
        `$${all.extractionCostUsd.toFixed(4)} extraction`,
    );
    env.io.out(
      `Config: llm extraction ${config.llm ? "on" : "off"} · embeddings ${
        config.embeddings ? "on" : "off"
      } (v0.2) · model tier ${config.modelTier}`,
    );
  } finally {
    db.close();
  }
  return 0;
}

function recordCounts(db: ReturnType<typeof openDatabase>, projectId: string): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM records
       WHERE project_id = ? AND superseded_at IS NULL GROUP BY type`,
    )
    .all(projectId) as Array<{ type: string; n: number }>;
  return new Map(rows.map((row) => [row.type, row.n]));
}

function supersededCount(db: ReturnType<typeof openDatabase>, projectId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM records WHERE project_id = ? AND superseded_at IS NOT NULL")
    .get(projectId) as { n: number };
  return row.n;
}

function globalPreferenceCount(db: ReturnType<typeof openDatabase>): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM records
       WHERE ${GLOBAL_VISIBLE_SQL} AND type = 'preference' AND superseded_at IS NULL`,
    )
    .get() as { n: number };
  return row.n;
}

function sessionTotals(
  db: ReturnType<typeof openDatabase>,
  projectId: string | null,
): SessionTotals {
  const filter = projectId === null ? "" : " WHERE project_id = @projectId";
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sessions,
              COALESCE(SUM(tokens_injected), 0) AS tokens,
              COALESCE(SUM(extraction_cost_usd), 0) AS cost,
              MAX(COALESCE(ended_at, started_at)) AS last
       FROM sessions${filter}`,
    )
    .get(projectId === null ? {} : { projectId }) as {
    sessions: number;
    tokens: number;
    cost: number;
    last: string | null;
  };
  return {
    sessions: row.sessions,
    tokensInjected: row.tokens,
    extractionCostUsd: row.cost,
    lastActivity: row.last,
  };
}
