/**
 * Ingest validated extraction output into the record store (SPEC §6).
 *
 * Mapping: decisions → `decision`, preferences → `preference` (global scope
 * lands in the `_global` namespace per SPEC §3.4), conventions →
 * `convention`, gotchas → `discovery`, active_work → `handover` (which
 * rule-supersedes the previous handover on insert, SPEC §3.5).
 *
 * Verbatim duplicates are dropped — but a duplicate arriving from a
 * *different* session is the cross-session re-appearance signal of the
 * confidence lifecycle (SPEC §3.3): the existing record's reinforce_count
 * is bumped, and an explicit duplicate of an inferred record upgrades it to
 * reinforced directly ("confirmed by one explicit statement"). The
 * count-threshold transition itself runs in `agentctx consolidate`.
 */
import type { Database } from "better-sqlite3";
import { getRecord, insertRecord } from "../storage/records.js";
import {
  BODY_MAX_CHARS,
  type Confidence,
  GLOBAL_PROJECT_ID,
  type NewRecord,
  type RecordType,
  TITLE_MAX_CHARS,
} from "../storage/types.js";
import type { ExtractionResult } from "./schema.js";

export interface IngestStats {
  written: number;
  /** Entries dropped for size, duplication, or storage validation. */
  dropped: number;
  /** Existing records whose reinforce_count was bumped or confidence upgraded. */
  reinforced: number;
}

interface CandidateRecord {
  type: RecordType;
  title: string;
  body: string;
  confidence: Confidence;
  scope: "project" | "global";
  supersedes?: string;
}

export function ingestExtraction(
  db: Database,
  projectId: string,
  sessionId: string,
  result: ExtractionResult,
  log: (message: string) => void,
): IngestStats {
  const stats: IngestStats = { written: 0, dropped: result.droppedEntries, reinforced: 0 };
  if (result.flushOk) {
    return stats; // trivial session — write nothing (SPEC §6)
  }

  const candidates: CandidateRecord[] = [];

  for (const d of result.decisions) {
    const candidate: CandidateRecord = {
      type: "decision",
      title: clampTitle(d.what),
      body: d.rationale === null ? d.what : `${d.what}\n\nRationale: ${d.rationale}`,
      confidence: d.confidence,
      scope: "project",
    };
    if (d.supersedes !== null) {
      candidate.supersedes = d.supersedes;
    }
    candidates.push(candidate);
  }

  for (const p of result.preferences) {
    candidates.push({
      type: "preference",
      title: clampTitle(p.rule),
      body: `${p.rule}\n\nCategory: ${p.category}`,
      confidence: p.confidence,
      scope: p.scope,
    });
  }

  for (const c of result.conventions) {
    candidates.push({
      type: "convention",
      title: clampTitle(c.convention),
      body: `${c.convention}\n\nApplies to: ${c.scope}`,
      confidence: c.confidence,
      scope: "project",
    });
  }

  for (const g of result.gotchas) {
    candidates.push({
      type: "discovery",
      title: clampTitle(g.pattern),
      body: `${g.pattern}\n\nWhy it matters: ${g.whyItMatters}`,
      confidence: "inferred",
      scope: "project",
    });
  }

  if (result.activeWork !== null) {
    const w = result.activeWork;
    const parts: string[] = [];
    if (w.currentTask !== "") parts.push(`Current task: ${w.currentTask}`);
    if (w.blockers.length > 0) parts.push(`Blockers:\n${bullets(w.blockers)}`);
    if (w.nextSteps.length > 0) parts.push(`Next steps:\n${bullets(w.nextSteps)}`);
    if (w.openQuestions.length > 0) parts.push(`Open questions:\n${bullets(w.openQuestions)}`);
    candidates.push({
      type: "handover",
      title: clampTitle(`Handover: ${w.currentTask !== "" ? w.currentTask : "session state"}`),
      body: parts.join("\n\n"),
      // Active work is the session's direct state, not a model hypothesis.
      confidence: "explicit",
      scope: "project",
    });
  }

  for (const candidate of candidates) {
    ingestCandidate(db, projectId, sessionId, candidate, stats, log);
  }
  return stats;
}

function ingestCandidate(
  db: Database,
  projectId: string,
  sessionId: string,
  candidate: CandidateRecord,
  stats: IngestStats,
  log: (message: string) => void,
): void {
  if (candidate.body.length > BODY_MAX_CHARS) {
    stats.dropped++; // oversized entries are dropped, not truncated (SPEC §6)
    log(
      `ingest: dropped oversized ${candidate.type} entry (${candidate.body.length} chars > ${BODY_MAX_CHARS} limit)`,
    );
    return;
  }
  const targetProjectId = candidate.scope === "global" ? GLOBAL_PROJECT_ID : projectId;

  const duplicate = findVerbatimDuplicate(db, targetProjectId, candidate);
  if (duplicate !== null) {
    stats.dropped++;
    if (duplicate.session_id !== sessionId) {
      applyReinforcement(db, duplicate, candidate.confidence, stats);
    }
    return;
  }

  const record: NewRecord = {
    projectId: targetProjectId,
    type: candidate.type,
    title: candidate.title,
    body: candidate.body,
    source: "llm_extraction",
    scope: candidate.scope,
    confidence: candidate.confidence,
    sessionId,
  };
  // Honor `supersedes` only when it points at a live record; a stale or
  // hallucinated id must not sink the new fact with it.
  if (candidate.supersedes !== undefined) {
    const target = getRecord(db, candidate.supersedes);
    if (target !== null) {
      record.supersedes = candidate.supersedes;
    } else {
      log(`ingest: ignoring invalid supersedes target ${candidate.supersedes}`);
    }
  }

  try {
    insertRecord(db, record);
    stats.written++;
  } catch (error) {
    stats.dropped++;
    log(`ingest: dropped ${candidate.type} entry: ${describe(error)}`);
  }
}

interface DuplicateRow {
  id: string;
  confidence: string;
  reinforce_count: number;
  session_id: string | null;
}

function findVerbatimDuplicate(
  db: Database,
  projectId: string,
  candidate: CandidateRecord,
): DuplicateRow | null {
  const row = db
    .prepare(
      `SELECT id, confidence, reinforce_count, session_id FROM records
       WHERE project_id = ? AND type = ? AND title = ? AND body = ?
         AND superseded_at IS NULL
       LIMIT 1`,
    )
    .get(projectId, candidate.type, candidate.title, candidate.body) as DuplicateRow | undefined;
  return row ?? null;
}

/** Cross-session re-appearance: bump the counter; explicit confirms (SPEC §3.3). */
function applyReinforcement(
  db: Database,
  existing: DuplicateRow,
  newConfidence: Confidence,
  stats: IngestStats,
): void {
  const confirmExplicitly = newConfidence === "explicit" && existing.confidence === "inferred";
  db.prepare(
    `UPDATE records SET reinforce_count = reinforce_count + 1
       ${confirmExplicitly ? ", confidence = 'reinforced'" : ""}
     WHERE id = ?`,
  ).run(existing.id);
  stats.reinforced++;
}

function clampTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= TITLE_MAX_CHARS ? oneLine : `${oneLine.slice(0, TITLE_MAX_CHARS - 1)}…`;
}

function bullets(items: string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
