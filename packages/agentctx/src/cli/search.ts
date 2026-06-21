/**
 * `agentctx search <query>` — FTS5 search from the terminal.
 *
 * Same engine and rules as every other retrieval path: BM25 +
 * recency/type/pinning rerank, superseded records filtered (Invariant 3),
 * reads scoped to this project plus global (SPEC §3.4). Results are a
 * compact index — `agentctx show <id>` prints the full record.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX } from "../mcp/tools.js";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import { searchRecords } from "../storage/search.js";
import { RECORD_TYPES, type RecordType } from "../storage/types.js";
import type { CliEnv } from "./env.js";

export const SEARCH_USAGE = `Usage: agentctx search <query> [options]

Options:
  --type <type>   restrict to one record type (${RECORD_TYPES.join(", ")})
  --limit <n>     maximum results (default ${SEARCH_LIMIT_DEFAULT}, max ${SEARCH_LIMIT_MAX})`;

export async function runSearch(env: CliEnv, args: string[]): Promise<number> {
  if (args.includes("--help")) {
    env.io.out(SEARCH_USAGE);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      type: { type: "string" },
      limit: { type: "string" },
    },
  });

  const query = positionals.join(" ").trim();
  if (query.length === 0) {
    env.io.err("agentctx search: a query is required");
    env.io.err(SEARCH_USAGE);
    return 1;
  }
  let type: RecordType | undefined;
  if (values.type !== undefined) {
    if (!(RECORD_TYPES as readonly string[]).includes(values.type)) {
      env.io.err(
        `agentctx search: invalid --type "${values.type}" — must be one of: ${RECORD_TYPES.join(", ")}`,
      );
      return 1;
    }
    type = values.type as RecordType;
  }
  let limit = SEARCH_LIMIT_DEFAULT;
  if (values.limit !== undefined) {
    const parsed = Number(values.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > SEARCH_LIMIT_MAX) {
      env.io.err(`agentctx search: --limit must be an integer between 1 and ${SEARCH_LIMIT_MAX}`);
      return 1;
    }
    limit = parsed;
  }

  if (!existsSync(env.dbPath)) {
    env.io.err("agentctx is not initialized — run `agentctx init` first");
    return 1;
  }

  const projectId = resolveProjectId(env.cwd);
  const db = openDatabase(env.dbPath);
  try {
    const outcome = searchRecords(
      db,
      projectId,
      query,
      type === undefined ? { limit } : { type, limit },
    );
    if (outcome.degraded !== undefined) {
      env.io.err(`note: FTS5 unavailable — degraded to ${outcome.degraded}`);
    }
    if (outcome.results.length === 0) {
      env.io.out("no matching records");
      return 0;
    }
    const now = Date.now();
    for (const hit of outcome.results) {
      const r = hit.record;
      env.io.out(
        `${r.id}  ${`[${r.type}/${r.confidence}]`.padEnd(24)} ${formatAge(r.recordedAt, now).padStart(4)}  ${r.title}`,
      );
    }
    env.io.out("");
    env.io.out("run `agentctx show <id>` for the full record");
  } finally {
    db.close();
  }
  return 0;
}

/** Compact age label: 12m, 5h, 3d, 2mo. */
export function formatAge(recordedAt: string, nowMs: number): string {
  const ageMs = Math.max(nowMs - Date.parse(recordedAt), 0);
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}
