/**
 * The v0.1 CLI surface (issue 7/7): status, search, show, export, profile.
 *
 * Includes the invariant audit for the CLI paths: superseded records never
 * surface in any default output (Invariant 3), and reads stay scoped to the
 * current project plus global (SPEC §3.4).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExport } from "../../src/cli/export.js";
import { describeNativeLoadError, unsupportedNodeReason } from "../../src/cli/node-support.js";
import { runProfile } from "../../src/cli/profile-cmd.js";
import { formatAge, runSearch } from "../../src/cli/search.js";
import { runShow } from "../../src/cli/show.js";
import { runStatus } from "../../src/cli/status.js";
import { openDatabase } from "../../src/storage/db.js";
import { resolveProjectId } from "../../src/storage/namespace.js";
import { getRecord, insertRecord, supersedeRecord } from "../../src/storage/records.js";
import { GLOBAL_PROJECT_ID, type NewRecord } from "../../src/storage/types.js";
import { type TestEnv, makeTestEnv } from "./helpers.js";

let t: TestEnv;
let projectId: string;

beforeEach(() => {
  t = makeTestEnv();
  projectId = resolveProjectId(t.env.cwd);
});

afterEach(() => t.cleanup());

function seed(partial: Partial<NewRecord> & { title: string; body: string }): string {
  const db = openDatabase(t.env.dbPath);
  try {
    return insertRecord(db, {
      projectId,
      type: "decision",
      source: "cli",
      ...partial,
    }).id;
  } finally {
    db.close();
  }
}

function seedSession(sessionId: string, tokens: number, cost: number): void {
  const db = openDatabase(t.env.dbPath);
  try {
    db.prepare(
      `INSERT INTO sessions (session_id, project_id, started_at, tokens_injected, extraction_cost_usd)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(sessionId, projectId, new Date().toISOString(), tokens, cost);
  } finally {
    db.close();
  }
}

describe("agentctx status", () => {
  it("fails with guidance before init", async () => {
    expect(await runStatus(t.env, [])).toBe(1);
    expect(t.stderr.join("\n")).toContain("agentctx init");
  });

  it("reports record counts, injected tokens, and extraction cost", async () => {
    seed({ title: "Use SQLite", body: "WAL mode." });
    seed({ type: "convention", title: "Conventional commits", body: "feat:, fix:." });
    seedSession("s-1", 1200, 0.015);
    seedSession("s-2", 800, 0.012);

    expect(await runStatus(t.env, [])).toBe(0);
    const out = t.stdout.join("\n");
    expect(out).toContain("decision     1");
    expect(out).toContain("convention   1");
    expect(out).toContain("total        2");
    expect(out).toContain("Sessions: 2");
    expect(out).toContain("2000 tokens injected");
    expect(out).toContain("$0.0270");
    expect(out).toContain("llm extraction on");
  });

  it("counts a _global preference only when its scope is global", async () => {
    const db = openDatabase(t.env.dbPath);
    try {
      // Visible global preference — counted.
      insertRecord(db, {
        projectId: GLOBAL_PROJECT_ID,
        type: "preference",
        scope: "global",
        source: "cli",
        title: "Prefer tabs",
        body: "Indent with tabs.",
      });
      // Mis-scoped row in the _global namespace — invisible to scoped reads,
      // so status must not count it either.
      insertRecord(db, {
        projectId: GLOBAL_PROJECT_ID,
        type: "preference",
        scope: "project",
        source: "cli",
        title: "Stray preference",
        body: "Written into _global with scope project.",
      });
    } finally {
      db.close();
    }

    expect(await runStatus(t.env, [])).toBe(0);
    expect(t.stdout.join("\n")).toContain("Global developer preferences: 1 active");
  });

  it("counts superseded records as history, not as active context", async () => {
    const id = seed({ title: "Old decision", body: "Original." });
    const db = openDatabase(t.env.dbPath);
    try {
      supersedeRecord(db, id, { title: "New decision", body: "Replaced.", source: "cli" });
    } finally {
      db.close();
    }
    await runStatus(t.env, []);
    const out = t.stdout.join("\n");
    expect(out).toContain("decision     1");
    expect(out).toContain("(+1 superseded, kept as history)");
  });
});

describe("agentctx search", () => {
  it("requires a query", async () => {
    expect(await runSearch(t.env, [])).toBe(1);
    expect(t.stderr.join("\n")).toContain("query is required");
  });

  it("finds records via FTS5 and points at show", async () => {
    const id = seed({ title: "Use better-sqlite3 for storage", body: "FTS5 ships compiled in." });
    expect(await runSearch(t.env, ["storage"])).toBe(0);
    const out = t.stdout.join("\n");
    expect(out).toContain(id);
    expect(out).toContain("[decision/inferred]");
    expect(out).toContain("agentctx show <id>");
  });

  it("never returns superseded records (Invariant 3)", async () => {
    const oldId = seed({ title: "Use mocha for testing", body: "Test runner choice." });
    const db = openDatabase(t.env.dbPath);
    let newId: string;
    try {
      newId = supersedeRecord(db, oldId, {
        title: "Use vitest for testing",
        body: "Replaces mocha.",
        source: "cli",
      }).replacement.id;
    } finally {
      db.close();
    }
    await runSearch(t.env, ["testing"]);
    const out = t.stdout.join("\n");
    expect(out).toContain(newId);
    expect(out).not.toContain(oldId);
  });

  it("never returns other projects' records (SPEC §3.4)", async () => {
    const db = openDatabase(t.env.dbPath);
    try {
      insertRecord(db, {
        projectId: "other-project",
        type: "decision",
        title: "Foreign sqlite decision",
        body: "Belongs elsewhere.",
        source: "cli",
      });
    } finally {
      db.close();
    }
    await runSearch(t.env, ["sqlite"]);
    expect(t.stdout.join("\n")).toContain("no matching records");
  });

  it("rejects an invalid --type and an out-of-range --limit", async () => {
    seed({ title: "anything", body: "anything" });
    expect(await runSearch(t.env, ["x", "--type", "nope"])).toBe(1);
    expect(await runSearch(t.env, ["x", "--limit", "0"])).toBe(1);
    expect(await runSearch(t.env, ["x", "--limit", "999"])).toBe(1);
  });
});

describe("agentctx show", () => {
  it("pretty-prints the full record", async () => {
    const id = seed({ title: "Use ULIDs", body: "Sortable by creation time.", pinned: true });
    expect(await runShow(t.env, [id])).toBe(0);
    const out = t.stdout.join("\n");
    expect(out).toContain("Use ULIDs");
    expect(out).toContain("Sortable by creation time.");
    expect(out).toContain(id);
    expect(out).toContain("pinned:");
    expect(out).toContain("source:");
  });

  it("refuses a superseded record by default and offers --history (Invariant 3)", async () => {
    const oldId = seed({ title: "Old", body: "Old body." });
    const db = openDatabase(t.env.dbPath);
    let newId: string;
    try {
      newId = supersedeRecord(db, oldId, { title: "New", body: "New body.", source: "cli" })
        .replacement.id;
    } finally {
      db.close();
    }

    expect(await runShow(t.env, [oldId])).toBe(1);
    expect(t.stderr.join("\n")).toContain(newId);
    expect(t.stderr.join("\n")).toContain("--history");
    expect(t.stdout.join("\n")).not.toContain("Old body.");

    expect(await runShow(t.env, [oldId, "--history"])).toBe(0);
    const out = t.stdout.join("\n");
    expect(out).toContain("SUPERSEDED");
    expect(out).toContain("Old body.");
  });

  it("fails cleanly on an unknown id", async () => {
    seed({ title: "x", body: "y" });
    expect(await runShow(t.env, ["01NOTAREALID"])).toBe(1);
    expect(t.stderr.join("\n")).toContain("no record");
  });
});

describe("agentctx export", () => {
  it("renders active records as organized Markdown, including global preferences", async () => {
    seed({ title: "Use SQLite", body: "WAL mode." });
    seed({ type: "handover", title: "Handover: CLI work", body: "Current task: ship v0.1." });
    const db = openDatabase(t.env.dbPath);
    try {
      insertRecord(db, {
        projectId: GLOBAL_PROJECT_ID,
        type: "preference",
        scope: "global",
        title: "Prefers vitest",
        body: "Test runner preference.",
        source: "llm_extraction",
      });
    } finally {
      db.close();
    }

    expect(await runExport(t.env, [])).toBe(0);
    const out = t.stdout.join("\n");
    expect(out).toContain("# agentctx context export");
    expect(out).toContain("## Decisions");
    expect(out).toContain("### Use SQLite");
    expect(out).toContain("## Last handover");
    expect(out).toContain("## Global developer preferences");
    expect(out).toContain("### Prefers vitest");
  });

  it("exports global non-preference records too — nothing visible is dropped", async () => {
    const db = openDatabase(t.env.dbPath);
    try {
      insertRecord(db, {
        projectId: GLOBAL_PROJECT_ID,
        type: "convention",
        scope: "global",
        title: "Global convention via MCP",
        body: "Recorded with ctx_record scope global.",
        source: "mcp_tool",
      });
    } finally {
      db.close();
    }
    expect(await runExport(t.env, [])).toBe(0);
    const out = t.stdout.join("\n");
    expect(out).toContain("## Other global records");
    expect(out).toContain("### Global convention via MCP");
    expect(out).toContain("1 active record(s)");
  });

  it("omits superseded records (Invariant 3) and writes --out files", async () => {
    const oldId = seed({ title: "Abandoned plan", body: "Replaced later." });
    const db = openDatabase(t.env.dbPath);
    try {
      supersedeRecord(db, oldId, { title: "Current plan", body: "The new way.", source: "cli" });
    } finally {
      db.close();
    }

    const outFile = join(t.root, "export.md");
    expect(await runExport(t.env, ["--out", outFile])).toBe(0);
    const markdown = readFileSync(outFile, "utf8");
    expect(markdown).toContain("### Current plan");
    expect(markdown).not.toContain("Abandoned plan");
    expect(t.stdout.join("\n")).toContain("exported 1 record(s)");
  });
});

describe("agentctx profile", () => {
  function seedGlobalPreference(title: string, body = "Body."): string {
    const db = openDatabase(t.env.dbPath);
    try {
      return insertRecord(db, {
        projectId: GLOBAL_PROJECT_ID,
        type: "preference",
        scope: "global",
        title,
        body,
        source: "llm_extraction",
      }).id;
    } finally {
      db.close();
    }
  }

  it("show lists only global preferences", async () => {
    seedGlobalPreference("Prefers small PRs");
    seed({ type: "preference", title: "Project-local preference", body: "Stays local." });

    expect(await runProfile(t.env, ["show"])).toBe(0);
    const out = t.stdout.join("\n");
    expect(out).toContain("Prefers small PRs");
    expect(out).not.toContain("Project-local preference");
  });

  it("edit supersedes the record with an explicit CLI version", async () => {
    const id = seedGlobalPreference("Prefers tabs", "Indentation.");
    expect(await runProfile(t.env, ["edit", id, "--title", "Prefers spaces"])).toBe(0);

    const db = openDatabase(t.env.dbPath);
    try {
      const old = getRecord(db, id, { includeSuperseded: true });
      expect(old?.supersededAt).not.toBeNull();
      const head = getRecord(db, old?.supersededBy ?? "");
      expect(head?.title).toBe("Prefers spaces");
      expect(head?.body).toBe("Indentation.");
      expect(head?.confidence).toBe("explicit");
      expect(head?.source).toBe("cli");
    } finally {
      db.close();
    }
    // The derived profile export is refreshed (SPEC §2.4).
    const exported = readFileSync(join(t.env.agentctxHome, "profile", "preferences.md"), "utf8");
    expect(exported).toContain("Prefers spaces");
  });

  it("edit requires --title or --body and refuses non-global records", async () => {
    const globalId = seedGlobalPreference("Something");
    expect(await runProfile(t.env, ["edit", globalId])).toBe(1);
    expect(t.stderr.join("\n")).toContain("--title and/or --body");

    const localId = seed({ title: "Local decision", body: "Not a preference." });
    expect(await runProfile(t.env, ["edit", localId, "--title", "x"])).toBe(1);
    expect(t.stderr.join("\n")).toContain("not a global preference");
  });

  it("clear deletes the preference after confirmation", async () => {
    const id = seedGlobalPreference("Wrong inference");

    // Refused without confirmation (no TTY answers false).
    expect(await runProfile(t.env, ["clear", id])).toBe(1);

    expect(await runProfile(t.env, ["clear", id, "--force"])).toBe(0);
    const db = openDatabase(t.env.dbPath);
    try {
      expect(getRecord(db, id, { includeSuperseded: true })).toBeNull();
    } finally {
      db.close();
    }
  });

  it("clear refuses a superseded id and points at the current head", async () => {
    const oldId = seedGlobalPreference("Outdated version");
    const db = openDatabase(t.env.dbPath);
    let headId: string;
    try {
      headId = supersedeRecord(db, oldId, {
        title: "Current version",
        body: "Body.",
        source: "cli",
      }).replacement.id;
    } finally {
      db.close();
    }

    expect(await runProfile(t.env, ["clear", oldId, "--force"])).toBe(1);
    expect(t.stderr.join("\n")).toContain(headId);
    const db2 = openDatabase(t.env.dbPath);
    try {
      expect(getRecord(db2, oldId, { includeSuperseded: true })).not.toBeNull();
    } finally {
      db2.close();
    }
  });

  it("clear detaches supersession pointers without resurrecting history", async () => {
    const oldId = seedGlobalPreference("First version");
    const db = openDatabase(t.env.dbPath);
    let headId: string;
    try {
      headId = supersedeRecord(db, oldId, {
        title: "Second version",
        body: "Body.",
        source: "cli",
      }).replacement.id;
    } finally {
      db.close();
    }

    expect(await runProfile(t.env, ["clear", headId, "--force"])).toBe(0);
    const db2 = openDatabase(t.env.dbPath);
    try {
      const old = getRecord(db2, oldId, { includeSuperseded: true });
      expect(old?.supersededAt).not.toBeNull(); // still history
      expect(old?.supersededBy).toBeNull(); // pointer detached
    } finally {
      db2.close();
    }
  });

  it("rejects unknown subcommands", async () => {
    expect(await runProfile(t.env, ["frobnicate"])).toBe(1);
    expect(t.stderr.join("\n")).toContain("unknown command");
  });
});

describe("node support (OQ-1)", () => {
  it("rejects Node majors below the floor with the support matrix", () => {
    const reason = unsupportedNodeReason("18.19.0");
    expect(reason).toContain("requires Node ≥ 20");
    expect(reason).toContain("20, 22, 24");
  });

  it("accepts supported versions", () => {
    expect(unsupportedNodeReason("20.11.0")).toBeNull();
    expect(unsupportedNodeReason("22.0.0")).toBeNull();
    expect(unsupportedNodeReason("24.1.0")).toBeNull();
  });

  it("translates native-load failures and leaves other errors alone", () => {
    const abi = describeNativeLoadError(
      new Error("was compiled against a different Node.js version using NODE_MODULE_VERSION 115."),
    );
    expect(abi).toContain("different Node version");
    expect(abi).toContain("reinstall");

    const missing = describeNativeLoadError(
      new Error("Could not locate the bindings file 'better_sqlite3.node'"),
    );
    expect(missing).toContain("no native binary");

    expect(describeNativeLoadError(new Error("ENOENT: no such file"))).toBeNull();
  });
});

describe("formatAge", () => {
  it("renders compact ages", () => {
    const now = Date.parse("2026-06-12T12:00:00Z");
    expect(formatAge("2026-06-12T11:30:00Z", now)).toBe("30m");
    expect(formatAge("2026-06-12T05:00:00Z", now)).toBe("7h");
    expect(formatAge("2026-06-09T12:00:00Z", now)).toBe("3d");
    expect(formatAge("2026-01-12T12:00:00Z", now)).toBe("5mo");
  });
});

describe("uninitialized guardrails", () => {
  it("search/show/export/profile fail with init guidance before init", async () => {
    expect(existsSync(t.env.dbPath)).toBe(false);
    expect(await runSearch(t.env, ["x"])).toBe(1);
    expect(await runShow(t.env, ["someid"])).toBe(1);
    expect(await runExport(t.env, [])).toBe(1);
    expect(await runProfile(t.env, ["show"])).toBe(1);
    expect(t.stderr.join("\n")).toContain("agentctx init");
  });
});
