import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SESSION_START_MAX_TOKENS, digestFilePath } from "../../src/hooks/digest.js";
import { CHARS_PER_TOKEN, estimateTokens } from "../../src/hooks/tokens.js";
import { insertRecord } from "../../src/storage/records.js";
import { type HookTestEnv, additionalContext, makeHookEnv } from "./helpers.js";

let t: HookTestEnv;

beforeEach(() => {
  t = makeHookEnv();
});

afterEach(() => {
  t.cleanup();
});

function writeDigest(sections: Record<string, string>): void {
  const path = digestFilePath(t.env.agentctxHome, t.projectId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      projectId: t.projectId,
      generatedAt: new Date().toISOString(),
      sections,
    }),
    "utf8",
  );
}

const basePayload = () => ({
  session_id: "sess-1",
  cwd: t.cwd,
  hook_event_name: "SessionStart",
  source: "startup",
});

describe("hook session-start", () => {
  it("emits nothing when there is no digest and no database", async () => {
    expect(await t.run("session-start", basePayload())).toBe(0);
    expect(t.emitted).toEqual([]);
  });

  it("emits the composed digest file as additionalContext", async () => {
    writeDigest({
      profile: "Project profile: TypeScript CLI.",
      decisions: "Decision: SQLite via better-sqlite3.",
      mcpHint: "Search deeper context via ctx_search.",
    });
    await t.run("session-start", basePayload());

    const ctx = additionalContext(t.emitted[0]);
    expect(ctx).toContain("TypeScript CLI");
    expect(ctx).toContain("better-sqlite3");
    expect(ctx).toContain("ctx_search");
  });

  it("hard-caps at 1,500 tokens, truncating from the bottom of the section list", async () => {
    writeDigest({
      profile: "P ".repeat(200), // ~100 tokens
      decisions: "decision line\n".repeat(2000), // way over budget alone
      handover: "HANDOVER-MARKER should be dropped entirely",
      mcpHint: "MCP-HINT-MARKER should be dropped entirely",
    });
    await t.run("session-start", basePayload());

    const ctx = additionalContext(t.emitted[0]);
    expect(ctx).not.toBeNull();
    const text = ctx as string;
    expect(estimateTokens(text)).toBeLessThanOrEqual(SESSION_START_MAX_TOKENS);
    expect(text.length).toBeLessThanOrEqual(SESSION_START_MAX_TOKENS * CHARS_PER_TOKEN);
    // Higher-priority sections survive; lower ones are gone.
    expect(text).toContain("P P");
    expect(text).toContain("decision line");
    expect(text).not.toContain("HANDOVER-MARKER");
    expect(text).not.toContain("MCP-HINT-MARKER");
  });

  it("re-emits on resume and accounts tokens both times", async () => {
    writeDigest({ profile: "Project profile: resume test." });
    // Database must exist for accounting (the hook never creates it).
    t.openDb().close();

    await t.run("session-start", basePayload());
    await t.run("session-start", { ...basePayload(), source: "resume" });
    expect(t.emitted).toHaveLength(2);

    const db = t.openDb();
    try {
      const row = db
        .prepare("SELECT tokens_injected FROM sessions WHERE session_id = ?")
        .get("sess-1") as { tokens_injected: number };
      const perInjection = estimateTokens(additionalContext(t.emitted[0]) as string);
      expect(row.tokens_injected).toBe(perInjection * 2);
    } finally {
      db.close();
    }
  });

  it("falls back to a minimal profile-only digest on first run", async () => {
    const db = t.openDb();
    try {
      insertRecord(db, {
        projectId: t.projectId,
        type: "profile",
        title: "Stack",
        body: "Node.js 20, TypeScript, Vitest",
        source: "cli",
      });
    } finally {
      db.close();
    }

    await t.run("session-start", basePayload());
    const ctx = additionalContext(t.emitted[0]);
    expect(ctx).toContain("Stack: Node.js 20");
  });

  it("treats a corrupt digest file as absent and degrades to the fallback", async () => {
    const path = digestFilePath(t.env.agentctxHome, t.projectId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "}{ definitely not json", "utf8");

    expect(await t.run("session-start", basePayload())).toBe(0);
    expect(t.emitted).toEqual([]); // no db either → nothing to emit, no error
  });

  it("emits nothing and exits 0 on empty stdin", async () => {
    t.setStdin("");
    const { runHook } = await import("../../src/hooks/runner.js");
    expect(await runHook("session-start", t.env)).toBe(0);
    expect(t.emitted).toEqual([]);
  });
});
