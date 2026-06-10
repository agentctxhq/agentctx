/**
 * Search module: FTS5 BM25 with recency/type/pinning rerank (ADR-005), and
 * a LIKE fallback marked `degraded: "like-search"` (SPEC §8 rung 4).
 *
 * Every query path filters superseded records (Invariant 3) and scopes
 * reads to own-project + global (SPEC §3.4).
 */
import type { Database } from "better-sqlite3";
import { SCOPE_FILTER_SQL, rowToRecord } from "./records.js";
import type { ContextRecord, RecordType } from "./types.js";

// Rerank weights are v0.1 placeholders (derived data per SPEC §7; tuned in v0.4).
const RECENCY_HALF_LIFE_DAYS = 30;
const RECENCY_FLOOR = 0.25;
const PINNED_BOOST = 2.0;
const TYPE_WEIGHTS: Record<RecordType, number> = {
  decision: 1.2,
  convention: 1.1,
  handover: 1.0,
  preference: 1.0,
  profile: 0.9,
  discovery: 0.8,
  bugfix: 0.8,
};
// Fetch more candidates than requested so the rerank has room to reorder.
const CANDIDATE_MULTIPLIER = 4;

export interface SearchOptions {
  type?: RecordType;
  limit?: number;
}

export interface SearchHit {
  record: ContextRecord;
  /** Reranked relevance — higher is better. Comparable within one result set only. */
  relevance: number;
}

export interface SearchOutcome {
  results: SearchHit[];
  degraded?: "like-search";
}

export function searchRecords(
  db: Database,
  projectId: string,
  query: string,
  options: SearchOptions = {},
): SearchOutcome {
  const limit = options.limit ?? 10;
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return { results: [] };
  }

  try {
    return { results: ftsSearch(db, projectId, tokens, options.type, limit) };
  } catch {
    // FTS5 unavailable or the MATCH expression failed — degrade, never error.
    return {
      results: likeSearch(db, projectId, tokens, options.type, limit),
      degraded: "like-search",
    };
  }
}

function ftsSearch(
  db: Database,
  projectId: string,
  tokens: string[],
  type: RecordType | undefined,
  limit: number,
): SearchHit[] {
  // Quote every token so raw prompt text can't break MATCH syntax; OR for recall.
  const match = tokens.map((t) => `"${t}"`).join(" OR ");
  const typeFilter = type === undefined ? "" : " AND r.type = @type";
  const params: Record<string, unknown> = {
    projectId,
    match,
    candidates: limit * CANDIDATE_MULTIPLIER,
  };
  if (type !== undefined) {
    params.type = type;
  }

  const rows = db
    .prepare(
      `SELECT r.*, bm25(records_fts) AS bm25_score
       FROM records_fts
       JOIN records r ON r.rowid = records_fts.rowid
       WHERE records_fts MATCH @match
         AND r.superseded_at IS NULL
         AND ${SCOPE_FILTER_SQL}${typeFilter}
       ORDER BY bm25_score
       LIMIT @candidates`,
    )
    .all(params) as Array<Parameters<typeof rowToRecord>[0] & { bm25_score: number }>;

  const now = Date.now();
  const hits = rows.map((row) => {
    const record = rowToRecord(row);
    // bm25() returns lower-is-better (negative for matches); flip to positive.
    const base = Math.max(-row.bm25_score, 0.001);
    return { record, relevance: base * rerankFactor(record, now) };
  });
  hits.sort((a, b) => b.relevance - a.relevance);
  return hits.slice(0, limit);
}

function likeSearch(
  db: Database,
  projectId: string,
  tokens: string[],
  type: RecordType | undefined,
  limit: number,
): SearchHit[] {
  const tokenClauses: string[] = [];
  const params: Record<string, unknown> = { projectId, candidates: limit * CANDIDATE_MULTIPLIER };
  tokens.forEach((token, i) => {
    tokenClauses.push(`(title LIKE @like${i} ESCAPE '\\' OR body LIKE @like${i} ESCAPE '\\')`);
    params[`like${i}`] = `%${escapeLike(token)}%`;
  });
  const typeFilter = type === undefined ? "" : " AND type = @type";
  if (type !== undefined) {
    params.type = type;
  }

  const rows = db
    .prepare(
      `SELECT * FROM records
       WHERE (${tokenClauses.join(" OR ")})
         AND superseded_at IS NULL
         AND ${SCOPE_FILTER_SQL}${typeFilter}
       ORDER BY pinned DESC, recorded_at DESC
       LIMIT @candidates`,
    )
    .all(params) as Array<Parameters<typeof rowToRecord>[0]>;

  const now = Date.now();
  const hits = rows.map((row) => {
    const record = rowToRecord(row);
    return { record, relevance: rerankFactor(record, now) };
  });
  hits.sort((a, b) => b.relevance - a.relevance);
  return hits.slice(0, limit);
}

function rerankFactor(record: ContextRecord, nowMs: number): number {
  const ageMs = Math.max(nowMs - Date.parse(record.recordedAt), 0);
  const ageDays = ageMs / 86_400_000;
  const recency = RECENCY_FLOOR + (1 - RECENCY_FLOOR) * 2 ** (-ageDays / RECENCY_HALF_LIFE_DAYS);
  const typeWeight = TYPE_WEIGHTS[record.type];
  const pinBoost = record.pinned ? PINNED_BOOST : 1;
  return recency * typeWeight * pinBoost;
}

function tokenize(query: string): string[] {
  return query.match(/[\p{L}\p{N}_.-]+/gu) ?? [];
}

function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (c) => `\\${c}`);
}
