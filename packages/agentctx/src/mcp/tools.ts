/**
 * The seven MCP tools (SPEC §5, ADR-008). Exactly seven — adding one is a
 * spec change, not an implementation detail.
 *
 * Contract: progressive disclosure. `ctx_search`/`ctx_related` return a
 * compact index (≤ 50 tokens/result, ≤ 15 results, no bodies); full content
 * only via `ctx_get`. No tool may bulk-return the store.
 *
 * Every read filters superseded records (Invariant 3) and scopes to
 * own-project + global (SPEC §3.4). Failures surface as a structured
 * `{error, degraded?}` payload — never as a raw exception in the channel.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Database } from "better-sqlite3";
import { buildSyncReport } from "../consolidate/drift.js";
import { PROFILE_TITLES } from "../profile/detect.js";
import { getRecord, insertRecord, listRecords, supersedeRecord } from "../storage/records.js";
import { searchRecords } from "../storage/search.js";
import {
  BODY_MAX_CHARS,
  type ContextRecord,
  GLOBAL_PROJECT_ID,
  RECORD_TYPES,
  type RecordType,
  SCOPES,
  type Scope,
  StorageError,
} from "../storage/types.js";

/** SPEC §5 `ctx_search`: limit ≤ 15, default 10. */
export const SEARCH_LIMIT_MAX = 15;
export const SEARCH_LIMIT_DEFAULT = 10;
/** SPEC §5 `ctx_get`: at most 10 ids per call. */
export const GET_IDS_MAX = 10;

export interface ToolContext {
  db: Database;
  projectId: string;
  cwd: string;
}

/**
 * A structured tool failure (SPEC §5 error shape). Thrown by handlers,
 * caught by the dispatcher, and serialized as `{error, degraded?}` — it
 * never propagates into the MCP channel as an exception.
 */
export class McpToolError extends Error {
  readonly degraded?: string;

  constructor(message: string, degraded?: string) {
    super(message);
    this.name = "McpToolError";
    if (degraded !== undefined) {
      this.degraded = degraded;
    }
  }
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (ctx: ToolContext, args: Record<string, unknown>) => unknown;
}

/** Compact index entry (SPEC §5: ≤ 50 tokens, no body). */
interface IndexEntry {
  id: string;
  type: RecordType;
  title: string;
  age: string;
  confidence: string;
  score: number;
}

// --- ctx_search ------------------------------------------------------------

function ctxSearch(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const query = requireString(args, "query");
  const type = optionalEnum(args, "type", RECORD_TYPES);
  const scope = optionalEnum(args, "scope", SCOPES);
  const file = optionalString(args, "file");
  const limit = clampLimit(optionalNumber(args, "limit"));

  // scope "global" searches only the reserved global namespace; the default
  // ("project") searches own project + global per SPEC §3.4.
  const namespace = scope === "global" ? GLOBAL_PROJECT_ID : ctx.projectId;

  // With a file filter, search at the cap and narrow afterwards so the
  // intersection is not starved by the pre-filter limit.
  const searchLimit = file === undefined ? limit : SEARCH_LIMIT_MAX;
  const outcome = searchRecords(ctx.db, namespace, query, {
    ...(type === undefined ? {} : { type }),
    limit: searchLimit,
  });

  let hits = outcome.results;
  if (file !== undefined) {
    const linked = linkedRecordIds(ctx, file);
    hits = hits.filter((hit) => linked.has(hit.record.id)).slice(0, limit);
  }

  const now = Date.now();
  const results: IndexEntry[] = hits.map((hit) => ({
    id: hit.record.id,
    type: hit.record.type,
    title: hit.record.title,
    age: formatAge(hit.record.recordedAt, now),
    confidence: hit.record.confidence,
    score: round3(hit.relevance),
  }));

  return outcome.degraded === undefined ? { results } : { results, degraded: outcome.degraded };
}

// --- ctx_get ---------------------------------------------------------------

function ctxGet(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const ids = requireStringArray(args, "ids");
  if (ids.length === 0) {
    throw new McpToolError("ids must contain at least one record id");
  }
  if (ids.length > GET_IDS_MAX) {
    throw new McpToolError(`ids accepts at most ${GET_IDS_MAX} ids per call; got ${ids.length}`);
  }

  const now = new Date().toISOString();
  const records: ContextRecord[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    // getRecord filters superseded rows (Invariant 3: history retrieval is a
    // v0.3 surface); a superseded or out-of-namespace id reads as missing.
    const record = getRecord(ctx.db, id);
    if (record === null || !visibleToProject(record, ctx.projectId)) {
      missing.push(id);
      continue;
    }
    records.push(record);
  }

  if (records.length > 0) {
    // Side effect per SPEC §5: access stats feed derived scoring (§7).
    const touch = ctx.db.prepare(
      "UPDATE records SET access_count = access_count + 1, last_accessed = ? WHERE id = ?",
    );
    const touchAll = ctx.db.transaction(() => {
      for (const record of records) {
        touch.run(now, record.id);
        record.accessCount += 1;
        record.lastAccessed = now;
      }
    });
    touchAll();
  }

  return { records, missing };
}

// --- ctx_record ------------------------------------------------------------

function ctxRecord(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const type = requireEnum(args, "type", RECORD_TYPES);
  const title = requireString(args, "title");
  const body = requireString(args, "body");
  const supersedes = optionalString(args, "supersedes");
  const scope: Scope = optionalEnum(args, "scope", SCOPES) ?? "project";

  // Global records live in the reserved namespace (SPEC §3.4).
  const projectId = scope === "global" ? GLOBAL_PROJECT_ID : ctx.projectId;

  if (supersedes !== undefined) {
    assertVisibleHead(ctx, supersedes, projectId);
  }

  const created = insertRecord(ctx.db, {
    projectId,
    type,
    title,
    body,
    scope,
    source: "mcp_tool",
    confidence: "explicit",
    ...(supersedes === undefined ? {} : { supersedes }),
  });

  return {
    id: created.id,
    type: created.type,
    title: created.title,
    scope: created.scope,
    recorded_at: created.recordedAt,
    ...(supersedes === undefined ? {} : { superseded: supersedes }),
  };
}

// --- ctx_supersede ---------------------------------------------------------

function ctxSupersede(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const oldId = requireString(args, "old_id");
  const newBody = requireString(args, "new_body");
  const rationale = requireString(args, "rationale");

  // Visibility check happens on the head lookup; supersedeRecord re-checks
  // supersession state and raises the structured already_superseded error.
  const old = getRecord(ctx.db, oldId, { includeSuperseded: true });
  if (old === null || !visibleToProject(old, ctx.projectId)) {
    throw new McpToolError(`no record with id ${oldId} in this project`);
  }

  // The record body is the only durable home for the rationale in v0.1.
  const body = `${newBody}\n\nRationale: ${rationale}`;
  if (body.length > BODY_MAX_CHARS) {
    throw new McpToolError(
      `new_body plus rationale is ${body.length} chars; the stored body is capped at ${BODY_MAX_CHARS}`,
    );
  }

  const { replacement } = supersedeRecord(ctx.db, oldId, {
    title: old.title,
    body,
    source: "mcp_tool",
    confidence: "explicit",
  });

  return { old_id: oldId, new_id: replacement.id };
}

// --- ctx_project -----------------------------------------------------------

function ctxProject(ctx: ToolContext): unknown {
  const profiles = new Map(
    listRecords(ctx.db, ctx.projectId, { type: "profile" }).map((r) => [r.title, r.body]),
  );

  const counts = ctx.db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM records
       WHERE superseded_at IS NULL
         AND (project_id = @projectId OR (project_id = '${GLOBAL_PROJECT_ID}' AND scope = 'global'))
       GROUP BY type`,
    )
    .all({ projectId: ctx.projectId }) as Array<{ type: string; n: number }>;
  const recordCounts: Record<string, number> = {};
  for (const row of counts) {
    recordCounts[row.type] = row.n;
  }

  const lastSession = ctx.db
    .prepare("SELECT MAX(COALESCE(ended_at, started_at)) AS at FROM sessions WHERE project_id = ?")
    .get(ctx.projectId) as { at: string | null } | undefined;

  return {
    name: projectName(ctx.cwd),
    project_id: ctx.projectId,
    stack: profiles.get(PROFILE_TITLES.stack) ?? null,
    commands: profiles.get(PROFILE_TITLES.commands) ?? null,
    entry_points: profiles.get(PROFILE_TITLES.entryPoints) ?? null,
    record_counts_by_type: recordCounts,
    last_session_at: lastSession?.at ?? null,
  };
}

// --- ctx_related -----------------------------------------------------------

function ctxRelated(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const file = requireString(args, "file");
  const linked = linkedRecordIds(ctx, file);
  if (linked.size === 0) {
    return { results: [] };
  }

  const now = Date.now();
  const results: IndexEntry[] = [];
  // Newest-first over the project-visible, non-superseded link targets;
  // compact-index shape and limits match ctx_search (SPEC §5).
  const candidates = [...linked]
    .map((id) => getRecord(ctx.db, id))
    .filter((r): r is ContextRecord => r !== null && visibleToProject(r, ctx.projectId))
    .sort((a, b) => (a.recordedAt < b.recordedAt ? 1 : -1))
    .slice(0, SEARCH_LIMIT_MAX);
  for (const record of candidates) {
    results.push({
      id: record.id,
      type: record.type,
      title: record.title,
      age: formatAge(record.recordedAt, now),
      confidence: record.confidence,
      score: round3(record.score),
    });
  }
  return { results };
}

// --- ctx_sync_claudemd -----------------------------------------------------

function ctxSyncClaudemd(ctx: ToolContext): unknown {
  // Read-only by contract (Invariant 5): applying changes to CLAUDE.md is
  // always a human/Claude action in the session, never this tool's side effect.
  const report = buildSyncReport(ctx.db, ctx.projectId, ctx.cwd);
  return {
    missing: report.missing.map(({ id, type, title }) => ({ id, type, title })),
    contradicted: report.contradicted,
    proposed_diff: report.proposed_diff,
  };
}

// --- registry ----------------------------------------------------------------

export function toolDefinitions(): ToolDefinition[] {
  return [
    {
      name: "ctx_search",
      description:
        "Search the project context store (decisions, conventions, preferences, discoveries, bugfixes, handovers, profile). " +
        "Returns a compact index without bodies — fetch full records with ctx_get.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Full-text search query" },
          type: {
            type: "string",
            enum: [...RECORD_TYPES],
            description: "Restrict to one record type",
          },
          file: {
            type: "string",
            description: "Restrict to records linked to this file path",
          },
          scope: {
            type: "string",
            enum: [...SCOPES],
            description:
              "'project' (default) searches this project plus global records; 'global' searches only global records",
          },
          limit: {
            type: "number",
            description: `Max results (default ${SEARCH_LIMIT_DEFAULT}, cap ${SEARCH_LIMIT_MAX})`,
          },
        },
        required: ["query"],
      },
      handler: ctxSearch,
    },
    {
      name: "ctx_get",
      description:
        "Fetch full context records by id (at most 10 per call), including bi-temporal fields and provenance. " +
        "Unknown ids are reported in a 'missing' array.",
      inputSchema: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: GET_IDS_MAX,
            description: `Record ids from ctx_search/ctx_related (at least 1, max ${GET_IDS_MAX})`,
          },
        },
        required: ["ids"],
      },
      handler: ctxGet,
    },
    {
      name: "ctx_record",
      description:
        "Record a fact explicitly: a decision, convention, preference, discovery, bugfix, or handover. " +
        "One atomic fact per record. Optionally supersedes an existing record.",
      inputSchema: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...RECORD_TYPES] },
          title: { type: "string", description: "Short title (max 120 chars)" },
          body: { type: "string", description: "The fact, with rationale (max 2000 chars)" },
          supersedes: {
            type: "string",
            description: "Id of a record this one replaces",
          },
          scope: {
            type: "string",
            enum: [...SCOPES],
            description: "'project' (default) or 'global' (applies across all projects)",
          },
        },
        required: ["type", "title", "body"],
      },
      handler: ctxRecord,
    },
    {
      name: "ctx_supersede",
      description:
        "Mark a record as no longer current and create its replacement (same type and scope). " +
        "The rationale is stored with the replacement body. Returns both ids.",
      inputSchema: {
        type: "object",
        properties: {
          old_id: { type: "string", description: "Id of the record being superseded" },
          new_body: { type: "string", description: "Body of the replacing record" },
          rationale: { type: "string", description: "Why the old record no longer holds" },
        },
        required: ["old_id", "new_body", "rationale"],
      },
      handler: ctxSupersede,
    },
    {
      name: "ctx_project",
      description:
        "Project overview: name, tech stack, commands, entry points, record counts by type, and last session time.",
      inputSchema: { type: "object", properties: {} },
      handler: ctxProject,
    },
    {
      name: "ctx_related",
      description:
        "Context records linked to a file path via entity associations, in the same compact index format as ctx_search.",
      inputSchema: {
        type: "object",
        properties: {
          file: { type: "string", description: "File path (absolute or relative to the project)" },
        },
        required: ["file"],
      },
      handler: ctxRelated,
    },
    {
      name: "ctx_sync_claudemd",
      description:
        "Report drift between the context store and CLAUDE.md: facts missing from it, contradicted by it, and a proposed diff. " +
        "Read-only — never edits CLAUDE.md.",
      inputSchema: { type: "object", properties: {} },
      handler: (ctx) => ctxSyncClaudemd(ctx),
    },
  ];
}

/**
 * Run one tool. All failures — argument validation, storage errors,
 * unexpected exceptions — come back as the structured SPEC §5 error payload.
 */
export function callTool(
  definitions: ToolDefinition[],
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): { payload: unknown; isError: boolean } {
  const tool = definitions.find((t) => t.name === name);
  if (tool === undefined) {
    return { payload: { error: `unknown tool "${name}"` }, isError: true };
  }
  try {
    return { payload: tool.handler(ctx, args), isError: false };
  } catch (err) {
    if (err instanceof McpToolError) {
      const payload: Record<string, unknown> = { error: err.message };
      if (err.degraded !== undefined) {
        payload.degraded = err.degraded;
      }
      return { payload, isError: true };
    }
    if (err instanceof StorageError) {
      return { payload: { error: err.message }, isError: true };
    }
    return {
      payload: { error: err instanceof Error ? err.message : String(err) },
      isError: true,
    };
  }
}

// --- helpers ----------------------------------------------------------------

function visibleToProject(record: ContextRecord, projectId: string): boolean {
  return (
    record.projectId === projectId ||
    (record.projectId === GLOBAL_PROJECT_ID && record.scope === "global")
  );
}

/**
 * A supersedes target must exist, be visible, be current, and live in the
 * same namespace as its replacement — a project-scoped record must never
 * supersede a global one (it would soft-delete the global record for every
 * project while the replacement stays local), and vice versa.
 */
function assertVisibleHead(ctx: ToolContext, id: string, targetNamespace: string): void {
  const record = getRecord(ctx.db, id, { includeSuperseded: true });
  if (record === null || !visibleToProject(record, ctx.projectId)) {
    throw new McpToolError(`supersedes: no record with id ${id} in this project`);
  }
  if (record.supersededAt !== null) {
    throw new McpToolError(
      `supersedes: record ${id} is already superseded by ${record.supersededBy ?? "unknown"}; supersede the current head instead`,
    );
  }
  if (record.projectId !== targetNamespace) {
    throw new McpToolError(
      record.projectId === GLOBAL_PROJECT_ID
        ? `supersedes: record ${id} is a global record; pass scope: "global" to supersede it`
        : `supersedes: record ${id} is project-scoped; it cannot be superseded by a global record`,
    );
  }
}

/** Record ids linked to a file path via record_entities or graph edges. */
function linkedRecordIds(ctx: ToolContext, file: string): Set<string> {
  const name = resolve(ctx.cwd, file);
  const rows = ctx.db
    .prepare(
      `SELECT re.record_id AS id FROM record_entities re
         JOIN nodes n ON n.id = re.entity_id
        WHERE n.kind = 'file' AND n.name = @name
       UNION
       SELECT e.from_id AS id FROM edges e
         JOIN nodes n ON n.id = e.to_id
        WHERE n.kind = 'file' AND n.name = @name`,
    )
    .all({ name }) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function projectName(cwd: string): string {
  try {
    const manifest = join(cwd, "package.json");
    if (existsSync(manifest)) {
      const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as { name?: unknown }).name === "string"
      ) {
        return (parsed as { name: string }).name;
      }
    }
  } catch {
    // Fall through to the directory name.
  }
  return basename(cwd);
}

function formatAge(recordedAt: string, nowMs: number): string {
  const ms = Math.max(nowMs - Date.parse(recordedAt), 0);
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 60) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return SEARCH_LIMIT_DEFAULT;
  if (!Number.isFinite(limit)) {
    throw new McpToolError("limit must be a finite number");
  }
  return Math.min(Math.max(Math.trunc(limit), 1), SEARCH_LIMIT_MAX);
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new McpToolError(`${name} is required and must be a non-empty string`);
  }
  return value;
}

function requireStringArray(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new McpToolError(`${name} must be an array of strings`);
  }
  return value as string[];
}

function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new McpToolError(`${name} must be a string`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number") {
    throw new McpToolError(`${name} must be a number`);
  }
  return value;
}

function requireEnum<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T {
  const value = optionalEnum(args, name, allowed);
  if (value === undefined) {
    throw new McpToolError(`${name} is required — one of: ${allowed.join(", ")}`);
  }
  return value;
}

function optionalEnum<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new McpToolError(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
