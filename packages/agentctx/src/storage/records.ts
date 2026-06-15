/**
 * Record store: validated inserts, atomic supersession (SPEC §3.5), and
 * default retrieval that always filters superseded records (Invariant 3)
 * and scopes reads to own-project + global (SPEC §3.4).
 */
import type { Database } from "better-sqlite3";
import {
  BODY_MAX_CHARS,
  CONFIDENCE_LEVELS,
  type ContextRecord,
  GLOBAL_PROJECT_ID,
  type NewRecord,
  RECORD_SOURCES,
  RECORD_TYPES,
  type RecordType,
  SCOPES,
  StorageError,
  TITLE_MAX_CHARS,
} from "./types.js";
import { ulid } from "./ulid.js";

/**
 * Global visibility (SPEC §3.4): a record in the reserved `_global` namespace
 * is visible to other projects iff its `scope` is `'global'`. This is the
 * canonical predicate — anything counting or reading cross-project globals
 * must apply it, otherwise a mis-scoped `_global` row leaks into results that
 * the scoped reads never surface.
 */
export const GLOBAL_VISIBLE_SQL = `(project_id = '${GLOBAL_PROJECT_ID}' AND scope = 'global')`;

/**
 * Read scoping (SPEC §3.4): a project sees its own namespace plus global
 * records from the reserved `_global` namespace — nothing else.
 *
 * Edge case: when projectId IS '_global', both branches match and all
 * _global rows are visible regardless of scope (a namespace sees its own
 * records without scope restriction). This asymmetry is intentional.
 */
export const SCOPE_FILTER_SQL = `(project_id = @projectId OR ${GLOBAL_VISIBLE_SQL})`;

interface RecordRow {
  id: string;
  project_id: string;
  type: string;
  title: string;
  body: string;
  scope: string;
  pinned: number;
  confidence: string;
  reinforce_count: number;
  valid_from: string;
  recorded_at: string;
  superseded_at: string | null;
  superseded_by: string | null;
  access_count: number;
  last_accessed: string | null;
  score: number;
  claudemd_drift_score: number;
  source: string;
  session_id: string | null;
  pending_embedding: number;
}

export function rowToRecord(row: RecordRow): ContextRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type as ContextRecord["type"],
    title: row.title,
    body: row.body,
    scope: row.scope as ContextRecord["scope"],
    pinned: row.pinned !== 0,
    confidence: row.confidence as ContextRecord["confidence"],
    reinforceCount: row.reinforce_count,
    validFrom: row.valid_from,
    recordedAt: row.recorded_at,
    supersededAt: row.superseded_at,
    supersededBy: row.superseded_by,
    accessCount: row.access_count,
    lastAccessed: row.last_accessed,
    score: row.score,
    claudemdDriftScore: row.claudemd_drift_score,
    source: row.source as ContextRecord["source"],
    sessionId: row.session_id,
    pendingEmbedding: row.pending_embedding !== 0,
  };
}

/**
 * Insert a record. Atomic with any supersession it implies:
 * - `supersedes` set → that record is marked superseded in the same transaction
 * - `handover` → the project's current handover is superseded (one per project)
 * - `profile` → the current profile record with the same title key is superseded
 */
export function insertRecord(db: Database, input: NewRecord): ContextRecord {
  validateNewRecord(input);
  const id = ulid();
  const now = new Date().toISOString();

  db.transaction(() => {
    // Pre-check gives a clear error before the INSERT; markSuperseded re-checks
    // inside the same transaction as a defensive guard for any future direct callers.
    if (input.supersedes !== undefined) {
      assertSupersedable(db, input.supersedes);
    }

    // Insert first: superseded_by references records(id), so the new row
    // must exist before any old row can point at it.
    db.prepare(
      `INSERT INTO records (
        id, project_id, type, title, body, scope, pinned, confidence,
        valid_from, recorded_at, source, session_id
      ) VALUES (
        @id, @projectId, @type, @title, @body, @scope, @pinned, @confidence,
        @validFrom, @recordedAt, @source, @sessionId
      )`,
    ).run({
      id,
      projectId: input.projectId,
      type: input.type,
      title: input.title,
      body: input.body,
      scope: input.scope ?? "project",
      pinned: input.pinned === true ? 1 : 0,
      confidence: input.confidence ?? "inferred",
      validFrom: input.validFrom ?? now,
      recordedAt: now,
      source: input.source,
      sessionId: input.sessionId ?? null,
    });

    if (input.supersedes !== undefined) {
      markSuperseded(db, input.supersedes, id, now);
    } else if (input.type === "handover") {
      supersedeByKey(db, input.projectId, "handover", null, id, now);
    } else if (input.type === "profile") {
      supersedeByKey(db, input.projectId, "profile", input.title, id, now);
    }
  })();

  const inserted = getRecord(db, id, { includeSuperseded: true });
  if (inserted === null) {
    throw new StorageError("record_not_found", `record ${id} vanished after insert`);
  }
  return inserted;
}

export interface SupersedeReplacement {
  title: string;
  body: string;
  source: NewRecord["source"];
  confidence?: NewRecord["confidence"];
  sessionId?: string;
  validFrom?: string;
}

/**
 * Mark `oldId` superseded and create its replacement (same type, scope, and
 * project as the old record) in one transaction. Fails with a structured
 * error if `oldId` is missing or already superseded.
 */
export function supersedeRecord(
  db: Database,
  oldId: string,
  replacement: SupersedeReplacement,
): { old: ContextRecord; replacement: ContextRecord } {
  const old = getRecord(db, oldId, { includeSuperseded: true });
  if (old === null) {
    throw new StorageError("record_not_found", `no record with id ${oldId}`);
  }
  if (old.supersededAt !== null) {
    throw new StorageError(
      "already_superseded",
      `record ${oldId} is already superseded by ${old.supersededBy ?? "unknown"}; supersede the current head instead`,
    );
  }

  const next: NewRecord = {
    projectId: old.projectId,
    type: old.type,
    title: replacement.title,
    body: replacement.body,
    source: replacement.source,
    scope: old.scope,
    confidence: replacement.confidence ?? "explicit",
    supersedes: oldId,
  };
  if (replacement.sessionId !== undefined) {
    next.sessionId = replacement.sessionId;
  }
  if (replacement.validFrom !== undefined) {
    next.validFrom = replacement.validFrom;
  }

  const created = insertRecord(db, next);
  const supersededOld = getRecord(db, oldId, { includeSuperseded: true });
  if (supersededOld === null) {
    throw new StorageError("record_not_found", `record ${oldId} vanished during supersession`);
  }
  return { old: supersededOld, replacement: created };
}

export interface GetOptions {
  includeSuperseded?: boolean;
}

export function getRecord(
  db: Database,
  id: string,
  options: GetOptions = {},
): ContextRecord | null {
  const filter = options.includeSuperseded === true ? "" : " AND superseded_at IS NULL";
  const row = db.prepare(`SELECT * FROM records WHERE id = ?${filter}`).get(id) as
    | RecordRow
    | undefined;
  return row === undefined ? null : rowToRecord(row);
}

export interface ListOptions {
  type?: RecordType;
  includeSuperseded?: boolean;
  limit?: number;
}

/** List records visible to a project (own namespace + global), newest first. */
export function listRecords(
  db: Database,
  projectId: string,
  options: ListOptions = {},
): ContextRecord[] {
  const where = [SCOPE_FILTER_SQL];
  if (options.includeSuperseded !== true) {
    where.push("superseded_at IS NULL");
  }
  if (options.type !== undefined) {
    where.push("type = @type");
  }

  const params: Record<string, unknown> = {
    projectId,
    limit: options.limit ?? 100,
  };
  if (options.type !== undefined) {
    params.type = options.type;
  }

  const rows = db
    .prepare(
      `SELECT * FROM records WHERE ${where.join(" AND ")}
       ORDER BY recorded_at DESC, id DESC LIMIT @limit`,
    )
    .all(params) as RecordRow[];
  return rows.map(rowToRecord);
}

function assertSupersedable(db: Database, oldId: string): void {
  const row = db
    .prepare("SELECT superseded_at, superseded_by FROM records WHERE id = ?")
    .get(oldId) as Pick<RecordRow, "superseded_at" | "superseded_by"> | undefined;
  if (row === undefined) {
    throw new StorageError("record_not_found", `cannot supersede ${oldId}: no such record`);
  }
  if (row.superseded_at !== null) {
    throw new StorageError(
      "already_superseded",
      `record ${oldId} is already superseded by ${row.superseded_by ?? "unknown"}`,
    );
  }
}

function markSuperseded(db: Database, oldId: string, newId: string, now: string): void {
  assertSupersedable(db, oldId);
  db.prepare("UPDATE records SET superseded_at = ?, superseded_by = ? WHERE id = ?").run(
    now,
    newId,
    oldId,
  );
}

/** Rule-based supersession for keyed types (SPEC §3.5). */
function supersedeByKey(
  db: Database,
  projectId: string,
  type: RecordType,
  titleKey: string | null,
  newId: string,
  now: string,
): void {
  const titleFilter = titleKey === null ? "" : " AND title = @title";
  const params: Record<string, unknown> = { projectId, type, now, newId };
  if (titleKey !== null) {
    params.title = titleKey;
  }
  db.prepare(
    `UPDATE records SET superseded_at = @now, superseded_by = @newId
     WHERE project_id = @projectId AND type = @type AND superseded_at IS NULL
       AND id != @newId${titleFilter}`,
  ).run(params);
}

function validateNewRecord(input: NewRecord): void {
  if (!(RECORD_TYPES as readonly string[]).includes(input.type)) {
    throw new StorageError(
      "invalid_type",
      `invalid record type "${input.type}" — must be one of: ${RECORD_TYPES.join(", ")}`,
    );
  }
  if (input.scope !== undefined && !(SCOPES as readonly string[]).includes(input.scope)) {
    throw new StorageError("invalid_scope", `invalid scope "${input.scope}"`);
  }
  if (
    input.confidence !== undefined &&
    !(CONFIDENCE_LEVELS as readonly string[]).includes(input.confidence)
  ) {
    throw new StorageError("invalid_confidence", `invalid confidence "${input.confidence}"`);
  }
  if (!(RECORD_SOURCES as readonly string[]).includes(input.source)) {
    throw new StorageError("invalid_source", `invalid source "${input.source}"`);
  }
  if (input.title.trim().length === 0) {
    throw new StorageError("empty_title", "title must not be empty");
  }
  if (input.title.length > TITLE_MAX_CHARS) {
    throw new StorageError(
      "title_too_long",
      `title is ${input.title.length} chars; max is ${TITLE_MAX_CHARS}`,
    );
  }
  if (input.body.trim().length === 0) {
    throw new StorageError("empty_body", "body must not be empty");
  }
  if (input.body.length > BODY_MAX_CHARS) {
    throw new StorageError(
      "body_too_long",
      `body is ${input.body.length} chars; max is ${BODY_MAX_CHARS}`,
    );
  }
}
