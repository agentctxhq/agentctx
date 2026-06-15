import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkRecordToEntity, upsertNode } from "../../src/hooks/entities.js";
import {
  GET_IDS_MAX,
  McpToolError,
  SEARCH_LIMIT_MAX,
  type ToolContext,
  callTool,
  toolDefinitions,
} from "../../src/mcp/tools.js";
import { getRecord, insertRecord } from "../../src/storage/records.js";
import { GLOBAL_PROJECT_ID, type NewRecord } from "../../src/storage/types.js";
import { ulid } from "../../src/storage/ulid.js";
import { type TempDb, openTempDb } from "../storage/helpers.js";

const PROJECT = "test-project";
const OTHER_PROJECT = "other-project";

let tmp: TempDb;
let cwd: string;
let ctx: ToolContext;
const tools = toolDefinitions();

beforeEach(() => {
  tmp = openTempDb();
  cwd = mkdtempSync(join(tmpdir(), "agentctx-mcp-cwd-"));
  ctx = { db: tmp.db, projectId: PROJECT, cwd };
});

afterEach(() => {
  tmp.cleanup();
  rmSync(cwd, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown> = {}) {
  return callTool(tools, ctx, name, args);
}

function seed(overrides: Partial<NewRecord> & Pick<NewRecord, "title" | "body">) {
  return insertRecord(tmp.db, {
    projectId: PROJECT,
    type: "decision",
    source: "cli",
    ...overrides,
  });
}

describe("tool registry", () => {
  it("exposes exactly the seven SPEC §5 tools", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "ctx_search",
      "ctx_get",
      "ctx_record",
      "ctx_supersede",
      "ctx_project",
      "ctx_related",
      "ctx_sync_claudemd",
    ]);
  });

  it("returns a structured error for an unknown tool", () => {
    const { payload, isError } = call("ctx_nope");
    expect(isError).toBe(true);
    expect(payload).toEqual({ error: 'unknown tool "ctx_nope"' });
  });
});

describe("ctx_search", () => {
  it("returns a compact index without bodies", () => {
    seed({ title: "Use SQLite for storage", body: "WAL mode, better-sqlite3 driver" });
    const { payload, isError } = call("ctx_search", { query: "sqlite storage" });
    expect(isError).toBe(false);
    const { results } = payload as { results: Array<Record<string, unknown>> };
    expect(results).toHaveLength(1);
    const entry = results[0];
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "age",
      "confidence",
      "id",
      "score",
      "title",
      "type",
    ]);
    expect(entry).not.toHaveProperty("body");
  });

  it("formats compact ages around the day boundary", () => {
    const now = Date.now();
    const rows = [
      { title: "Boundary age 23h", age: "23h", recordedAt: now - 23 * 60 * 60_000 },
      { title: "Boundary age 30h", age: "1d", recordedAt: now - 30 * 60 * 60_000 },
      { title: "Boundary age 48h", age: "2d", recordedAt: now - 48 * 60 * 60_000 },
    ];

    for (const row of rows) {
      const record = seed({ title: row.title, body: "shared boundary age probe" });
      tmp.db
        .prepare("UPDATE records SET recorded_at = ? WHERE id = ?")
        .run(new Date(row.recordedAt).toISOString(), record.id);
    }

    const { payload } = call("ctx_search", { query: "boundary age probe", limit: 3 });
    const { results } = payload as { results: Array<{ title: string; age: string }> };
    const ages = new Map(results.map((result) => [result.title, result.age]));

    for (const row of rows) {
      expect(ages.get(row.title)).toBe(row.age);
    }
  });

  it("filters superseded records and foreign namespaces", () => {
    const old = seed({ title: "Old decision", body: "use REST everywhere" });
    seed({ title: "New decision", body: "use gRPC everywhere", supersedes: old.id });
    insertRecord(tmp.db, {
      projectId: OTHER_PROJECT,
      type: "decision",
      title: "Foreign decision",
      body: "use gRPC in another project",
      source: "cli",
    });

    const { payload } = call("ctx_search", { query: "gRPC REST decision" });
    const { results } = payload as { results: Array<{ title: string }> };
    expect(results.map((r) => r.title)).toEqual(["New decision"]);
  });

  it("includes global records by default and only them with scope=global", () => {
    seed({ title: "Project fact", body: "tabs not spaces here" });
    insertRecord(tmp.db, {
      projectId: GLOBAL_PROJECT_ID,
      type: "preference",
      title: "Global fact",
      body: "tabs not spaces everywhere",
      scope: "global",
      source: "cli",
    });

    const both = call("ctx_search", { query: "tabs spaces" }).payload as {
      results: Array<{ title: string }>;
    };
    expect(both.results.map((r) => r.title).sort()).toEqual(["Global fact", "Project fact"]);

    const globalOnly = call("ctx_search", { query: "tabs spaces", scope: "global" }).payload as {
      results: Array<{ title: string }>;
    };
    expect(globalOnly.results.map((r) => r.title)).toEqual(["Global fact"]);
  });

  it("applies the type filter and clamps limit to the cap", () => {
    for (let i = 0; i < 20; i++) {
      seed({ title: `Decision ${i} about caching`, body: `caching detail ${i}` });
    }
    seed({ type: "bugfix", title: "Bugfix about caching", body: "cache invalidation bug" });

    const { payload } = call("ctx_search", { query: "caching", limit: 50 });
    const { results } = payload as { results: Array<{ type: string }> };
    expect(results.length).toBeLessThanOrEqual(SEARCH_LIMIT_MAX);

    const typed = call("ctx_search", { query: "caching", type: "bugfix" }).payload as {
      results: Array<{ type: string }>;
    };
    expect(typed.results.every((r) => r.type === "bugfix")).toBe(true);
  });

  it("narrows to file-linked records when file is given", () => {
    const linked = seed({ title: "Auth flow decision", body: "JWT in auth module" });
    seed({ title: "Unrelated auth note", body: "JWT elsewhere" });
    const filePath = resolve(cwd, "src/auth.ts");
    linkRecordToEntity(tmp.db, linked.id, upsertNode(tmp.db, PROJECT, "file", filePath));

    const { payload } = call("ctx_search", { query: "JWT auth", file: "src/auth.ts" });
    const { results } = payload as { results: Array<{ id: string }> };
    expect(results.map((r) => r.id)).toEqual([linked.id]);
  });

  it("marks degraded like-search when FTS5 is unavailable", () => {
    seed({ title: "Fallback fact", body: "search should still work" });
    tmp.db.exec("DROP TABLE records_fts");

    const { payload, isError } = call("ctx_search", { query: "fallback" });
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ degraded: "like-search" });
    const { results } = payload as { results: Array<{ title: string }> };
    expect(results.map((r) => r.title)).toEqual(["Fallback fact"]);
  });

  it("rejects a missing query with a structured error", () => {
    const { payload, isError } = call("ctx_search", {});
    expect(isError).toBe(true);
    expect(payload).toHaveProperty("error");
  });
});

describe("ctx_get", () => {
  it("advertises the same id cap as GET_IDS_MAX", () => {
    const schema = tools.find((tool) => tool.name === "ctx_get");
    expect(schema?.description).toContain(`at most ${String(GET_IDS_MAX)} per call`);
  });

  it("returns full records, reports unknown ids as missing, and bumps access stats", () => {
    const record = seed({ title: "Full record", body: "the whole body" });
    const { payload, isError } = call("ctx_get", { ids: [record.id, "nope"] });
    expect(isError).toBe(false);

    const result = payload as { records: Array<Record<string, unknown>>; missing: string[] };
    expect(result.missing).toEqual(["nope"]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      id: record.id,
      body: "the whole body",
      source: "cli",
      supersededAt: null,
      accessCount: 1,
    });

    const stored = getRecord(tmp.db, record.id);
    expect(stored?.accessCount).toBe(1);
    expect(stored?.lastAccessed).not.toBeNull();
  });

  it("treats superseded and foreign-project ids as missing", () => {
    const old = seed({ title: "Old", body: "old body" });
    seed({ title: "New", body: "new body", supersedes: old.id });
    const foreign = insertRecord(tmp.db, {
      projectId: OTHER_PROJECT,
      type: "discovery",
      title: "Foreign",
      body: "not yours",
      source: "cli",
    });

    const { payload } = call("ctx_get", { ids: [old.id, foreign.id] });
    expect(payload).toMatchObject({ records: [], missing: [old.id, foreign.id] });
  });

  it("rejects more than the id cap and empty arrays", () => {
    const tooMany = Array.from({ length: GET_IDS_MAX + 1 }, () => ulid());
    expect(call("ctx_get", { ids: tooMany }).isError).toBe(true);
    expect(call("ctx_get", { ids: [] }).isError).toBe(true);
    expect(call("ctx_get", { ids: "not-an-array" }).isError).toBe(true);
  });
});

describe("ctx_record", () => {
  it("writes an explicit mcp_tool record", () => {
    const { payload, isError } = call("ctx_record", {
      type: "convention",
      title: "Arrow functions",
      body: "Always use arrow functions for callbacks",
    });
    expect(isError).toBe(false);

    const { id } = payload as { id: string };
    const stored = getRecord(tmp.db, id);
    expect(stored).toMatchObject({
      type: "convention",
      source: "mcp_tool",
      confidence: "explicit",
      projectId: PROJECT,
      scope: "project",
    });
  });

  it("stores scope=global records in the global namespace", () => {
    const { payload } = call("ctx_record", {
      type: "preference",
      title: "Conventional commits",
      body: "Prefers conventional commit messages",
      scope: "global",
    });
    const { id } = payload as { id: string };
    expect(getRecord(tmp.db, id)).toMatchObject({
      projectId: GLOBAL_PROJECT_ID,
      scope: "global",
    });
  });

  it("supersedes atomically when supersedes is given", () => {
    const old = seed({ title: "Old rule", body: "old rule body" });
    const { payload } = call("ctx_record", {
      type: "decision",
      title: "New rule",
      body: "new rule body",
      supersedes: old.id,
    });
    const { id } = payload as { id: string };

    const oldStored = getRecord(tmp.db, old.id, { includeSuperseded: true });
    expect(oldStored?.supersededBy).toBe(id);
    expect(oldStored?.supersededAt).not.toBeNull();
  });

  it("returns structured errors for invalid type, oversized fields, and bad supersedes", () => {
    expect(call("ctx_record", { type: "saga", title: "t", body: "b" }).isError).toBe(true);
    expect(
      call("ctx_record", { type: "decision", title: "x".repeat(121), body: "b" }).isError,
    ).toBe(true);
    expect(
      call("ctx_record", { type: "decision", title: "t", body: "x".repeat(2001) }).isError,
    ).toBe(true);

    const foreign = insertRecord(tmp.db, {
      projectId: OTHER_PROJECT,
      type: "decision",
      title: "Foreign",
      body: "body",
      source: "cli",
    });
    const result = call("ctx_record", {
      type: "decision",
      title: "t",
      body: "b",
      supersedes: foreign.id,
    });
    expect(result.isError).toBe(true);
    expect(result.payload).toHaveProperty("error");
  });

  it("rejects an already-superseded supersedes target with a structured error", () => {
    const old = seed({ title: "Stale head", body: "v1" });
    seed({ title: "Current head", body: "v2", supersedes: old.id });

    const { payload, isError } = call("ctx_record", {
      type: "decision",
      title: "v3",
      body: "v3 body",
      supersedes: old.id,
    });
    expect(isError).toBe(true);
    expect((payload as { error: string }).error).toContain("already superseded");
  });

  it("refuses cross-namespace supersession in either direction", () => {
    const globalRecord = insertRecord(tmp.db, {
      projectId: GLOBAL_PROJECT_ID,
      type: "preference",
      title: "Global preference",
      body: "applies everywhere",
      scope: "global",
      source: "cli",
    });

    // A project-scoped record must not soft-delete a global one for every project.
    const projectOverGlobal = call("ctx_record", {
      type: "preference",
      title: "Local override",
      body: "local body",
      supersedes: globalRecord.id,
    });
    expect(projectOverGlobal.isError).toBe(true);
    expect((projectOverGlobal.payload as { error: string }).error).toContain('scope: "global"');
    expect(getRecord(tmp.db, globalRecord.id)?.supersededAt).toBeNull();

    // And a global record must not absorb a project-scoped head.
    const projectRecord = seed({ title: "Project rule", body: "project body" });
    const globalOverProject = call("ctx_record", {
      type: "decision",
      title: "Global rule",
      body: "global body",
      scope: "global",
      supersedes: projectRecord.id,
    });
    expect(globalOverProject.isError).toBe(true);
    expect(getRecord(tmp.db, projectRecord.id)?.supersededAt).toBeNull();

    // With the matching scope, superseding the global head works.
    const matched = call("ctx_record", {
      type: "preference",
      title: "Global preference v2",
      body: "updated everywhere",
      scope: "global",
      supersedes: globalRecord.id,
    });
    expect(matched.isError).toBe(false);
    expect(
      getRecord(tmp.db, globalRecord.id, { includeSuperseded: true })?.supersededAt,
    ).not.toBeNull();
  });
});

describe("ctx_supersede", () => {
  it("creates the replacement (same type/scope), keeps the rationale, returns both ids", () => {
    const old = seed({ type: "convention", title: "Spacing", body: "two spaces" });
    const { payload, isError } = call("ctx_supersede", {
      old_id: old.id,
      new_body: "four spaces",
      rationale: "team vote on 2026-06-01",
    });
    expect(isError).toBe(false);

    const result = payload as { old_id: string; new_id: string };
    expect(result.old_id).toBe(old.id);

    const replacement = getRecord(tmp.db, result.new_id);
    expect(replacement).toMatchObject({
      type: "convention",
      title: "Spacing",
      confidence: "explicit",
      source: "mcp_tool",
    });
    expect(replacement?.body).toContain("four spaces");
    expect(replacement?.body).toContain("team vote on 2026-06-01");

    const oldStored = getRecord(tmp.db, old.id, { includeSuperseded: true });
    expect(oldStored?.supersededBy).toBe(result.new_id);
  });

  it("fails with a structured error when the head is already superseded", () => {
    const old = seed({ title: "Head", body: "v1" });
    seed({ title: "Head v2", body: "v2", supersedes: old.id });

    const { payload, isError } = call("ctx_supersede", {
      old_id: old.id,
      new_body: "v3",
      rationale: "stale",
    });
    expect(isError).toBe(true);
    expect((payload as { error: string }).error).toContain("already superseded");
  });

  it("rejects unknown or foreign ids", () => {
    expect(call("ctx_supersede", { old_id: "nope", new_body: "b", rationale: "r" }).isError).toBe(
      true,
    );

    const foreign = insertRecord(tmp.db, {
      projectId: OTHER_PROJECT,
      type: "decision",
      title: "Foreign",
      body: "body",
      source: "cli",
    });
    expect(
      call("ctx_supersede", { old_id: foreign.id, new_body: "b", rationale: "r" }).isError,
    ).toBe(true);
  });
});

describe("ctx_project", () => {
  it("reports name, profile fields, counts, and last session", () => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "my-app" }));
    seed({ type: "profile", title: "Stack", body: "Runtime: Node.js" });
    seed({ type: "profile", title: "Commands", body: "npm test — vitest" });
    seed({ title: "A decision", body: "decided" });
    tmp.db
      .prepare(
        "INSERT INTO sessions (session_id, project_id, started_at, ended_at) VALUES (?, ?, ?, ?)",
      )
      .run("s1", PROJECT, "2026-06-01T00:00:00Z", "2026-06-01T01:00:00Z");

    const { payload, isError } = call("ctx_project");
    expect(isError).toBe(false);
    expect(payload).toMatchObject({
      name: "my-app",
      project_id: PROJECT,
      stack: "Runtime: Node.js",
      commands: "npm test — vitest",
      entry_points: null,
      record_counts_by_type: { profile: 2, decision: 1 },
      last_session_at: "2026-06-01T01:00:00Z",
    });
  });

  it("falls back to the directory name and nulls on an empty store", () => {
    const { payload } = call("ctx_project");
    const result = payload as Record<string, unknown>;
    expect(result.name).toBe(cwd.split("/").pop());
    expect(result.stack).toBeNull();
    expect(result.last_session_at).toBeNull();
    expect(result.record_counts_by_type).toEqual({});
  });
});

describe("ctx_related", () => {
  it("returns compact entries for records linked to a file", () => {
    const filePath = resolve(cwd, "src/db.ts");
    const nodeId = upsertNode(tmp.db, PROJECT, "file", filePath);
    const linked = seed({ type: "discovery", title: "DB quirk", body: "WAL checkpoint detail" });
    linkRecordToEntity(tmp.db, linked.id, nodeId);
    seed({ title: "Unlinked", body: "unrelated" });

    const { payload, isError } = call("ctx_related", { file: "src/db.ts" });
    expect(isError).toBe(false);
    const { results } = payload as { results: Array<Record<string, unknown>> };
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: linked.id, type: "discovery", title: "DB quirk" });
    expect(results[0]).not.toHaveProperty("body");
  });

  it("follows graph edges and filters superseded records", () => {
    const filePath = resolve(cwd, "src/edge.ts");
    const nodeId = upsertNode(tmp.db, PROJECT, "file", filePath);
    const viaEdge = seed({ title: "Edge-linked", body: "linked via edges table" });
    tmp.db
      .prepare("INSERT INTO edges (id, from_id, to_id, rel_type) VALUES (?, ?, ?, ?)")
      .run(ulid(), viaEdge.id, nodeId, "applies_to");

    const superseded = seed({ title: "Old linked", body: "old" });
    linkRecordToEntity(tmp.db, superseded.id, nodeId);
    seed({ title: "Replacement", body: "new", supersedes: superseded.id });

    const { payload } = call("ctx_related", { file: filePath });
    const { results } = payload as { results: Array<{ id: string }> };
    expect(results.map((r) => r.id)).toEqual([viaEdge.id]);
  });

  it("returns an empty list for an unknown file", () => {
    const { payload, isError } = call("ctx_related", { file: "does/not/exist.ts" });
    expect(isError).toBe(false);
    expect(payload).toEqual({ results: [] });
  });
});

describe("ctx_sync_claudemd", () => {
  it("returns a well-formed empty drift report", () => {
    const { payload, isError } = call("ctx_sync_claudemd");
    expect(isError).toBe(false);
    expect(payload).toEqual({ missing: [], contradicted: [], proposed_diff: "" });
  });
});

describe("error capture", () => {
  it("never lets a McpToolError escape callTool", () => {
    const broken = [
      {
        name: "ctx_search",
        description: "",
        inputSchema: {},
        handler: () => {
          throw new McpToolError("boom", "like-search");
        },
      },
    ];
    const { payload, isError } = callTool(broken, ctx, "ctx_search", {});
    expect(isError).toBe(true);
    expect(payload).toEqual({ error: "boom", degraded: "like-search" });
  });

  it("captures unexpected exceptions as structured errors", () => {
    const broken = [
      {
        name: "ctx_search",
        description: "",
        inputSchema: {},
        handler: () => {
          throw new Error("unexpected");
        },
      },
    ];
    const { payload, isError } = callTool(broken, ctx, "ctx_search", {});
    expect(isError).toBe(true);
    expect(payload).toEqual({ error: "unexpected" });
  });
});
