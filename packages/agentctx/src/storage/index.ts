/**
 * Storage foundation — public surface (v0.1 issue 1/7).
 */
export { defaultDbPath, hasFts5, openDatabase } from "./db.js";
export {
  GLOBAL_PROJECT_ID,
  normalizeGitRemoteUrl,
  projectIdFromPath,
  projectIdFromRemote,
  resolveProjectId,
} from "./namespace.js";
export {
  type GetOptions,
  type ListOptions,
  type SupersedeReplacement,
  getRecord,
  insertRecord,
  listRecords,
  supersedeRecord,
} from "./records.js";
export { applyMigrations, currentSchemaVersion, SCHEMA_VERSION } from "./schema.js";
export {
  type SearchHit,
  type SearchOptions,
  type SearchOutcome,
  searchRecords,
} from "./search.js";
export {
  BODY_MAX_CHARS,
  CONFIDENCE_LEVELS,
  type Confidence,
  type ContextRecord,
  type NewRecord,
  RECORD_SOURCES,
  RECORD_TYPES,
  type RecordSource,
  type RecordType,
  SCOPES,
  type Scope,
  StorageError,
  type StorageErrorCode,
  TITLE_MAX_CHARS,
} from "./types.js";
export { ulid } from "./ulid.js";
