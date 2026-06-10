/**
 * Storage layer types — the SPEC §3 context model.
 *
 * Field names are camelCase in the programmatic API; the SQLite schema
 * (SPEC §3.1) uses snake_case. Mapping happens at the query layer.
 */

/** The seven record types (SPEC §3.2). Adding one is a spec change. */
export const RECORD_TYPES = [
  "decision",
  "convention",
  "preference",
  "discovery",
  "bugfix",
  "handover",
  "profile",
] as const;

export type RecordType = (typeof RECORD_TYPES)[number];

/** Trust discriminator (SPEC §3.3). Transitions are one-way. */
export const CONFIDENCE_LEVELS = ["explicit", "inferred", "reinforced"] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const SCOPES = ["project", "global"] as const;

export type Scope = (typeof SCOPES)[number];

/** Provenance of a record (SPEC §3.1 `source`). */
export const RECORD_SOURCES = [
  "llm_extraction",
  "hook_observation",
  "mcp_tool",
  "cli",
  "import",
] as const;

export type RecordSource = (typeof RECORD_SOURCES)[number];

/** Validation limits (SPEC §5 `ctx_record`, §9). */
export const TITLE_MAX_CHARS = 120;
export const BODY_MAX_CHARS = 2000;

/** Reserved namespace for the global developer profile (SPEC §3.4). */
export const GLOBAL_PROJECT_ID = "_global";

/** A fully materialized record row (SPEC §3.1). */
export interface ContextRecord {
  id: string;
  projectId: string;
  type: RecordType;
  title: string;
  body: string;
  scope: Scope;
  pinned: boolean;
  confidence: Confidence;
  reinforceCount: number;
  /** When the fact became true (ISO 8601). */
  validFrom: string;
  /** When we ingested it (ISO 8601). */
  recordedAt: string;
  /** NULL = currently valid (ADR-011). */
  supersededAt: string | null;
  supersededBy: string | null;
  accessCount: number;
  lastAccessed: string | null;
  score: number;
  claudemdDriftScore: number;
  source: RecordSource;
  sessionId: string | null;
  pendingEmbedding: boolean;
}

/** Input for inserting a record. Bi-temporal and derived fields are filled in by the store. */
export interface NewRecord {
  projectId: string;
  type: RecordType;
  title: string;
  body: string;
  source: RecordSource;
  scope?: Scope;
  confidence?: Confidence;
  pinned?: boolean;
  /** Defaults to now. */
  validFrom?: string;
  sessionId?: string;
  /** Record id to supersede atomically with this insert (SPEC §3.5). */
  supersedes?: string;
}

export type StorageErrorCode =
  | "invalid_type"
  | "invalid_scope"
  | "invalid_confidence"
  | "invalid_source"
  | "empty_title"
  | "empty_body"
  | "title_too_long"
  | "body_too_long"
  | "record_not_found"
  | "already_superseded"
  | "fts5_unavailable";

/**
 * Typed storage failure with a stable `code`, so the MCP/hook layers can map
 * to SPEC §5's structured `{error}` shape without string matching.
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}
