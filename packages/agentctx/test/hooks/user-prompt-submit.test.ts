import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dedupFilePath } from "../../src/hooks/dedup.js";
import { estimateTokens } from "../../src/hooks/tokens.js";
import {
  PROMPT_SUBMIT_MAX_CHARS,
  PROMPT_SUBMIT_MAX_TOKENS,
  formatInjection,
} from "../../src/hooks/user-prompt-submit.js";
import { insertRecord } from "../../src/storage/records.js";
import type { SearchHit } from "../../src/storage/search.js";
import type { ContextRecord } from "../../src/storage/types.js";
import { type HookTestEnv, additionalContext, makeHookEnv } from "./helpers.js";

let t: HookTestEnv;

beforeEach(() => {
  t = makeHookEnv();
});

afterEach(() => {
  t.cleanup();
});

function seedRecords(count: number, topic = "sqlite"): void {
  const db = t.openDb();
  try {
    for (let i = 0; i < count; i++) {
      insertRecord(db, {
        projectId: t.projectId,
        type: "decision",
        title: `Decision ${i} about ${topic}`,
        body: `We chose approach ${i} for ${topic} because of reasons.`,
        source: "cli",
        confidence: "explicit",
      });
    }
  } finally {
    db.close();
  }
}

const payload = (prompt: string, sessionId = "sess-1") => ({
  session_id: sessionId,
  cwd: t.cwd,
  hook_event_name: "UserPromptSubmit",
  prompt,
});

describe("hook user-prompt-submit", () => {
  it("injects at most the top-3 matching records", async () => {
    seedRecords(6);
    await t.run("user-prompt-submit", payload("how do we handle sqlite?"));

    const ctx = additionalContext(t.emitted[0]) as string;
    expect(ctx).toContain("Relevant project context");
    expect((ctx.match(/\[decision\]/g) ?? []).length).toBe(3);
  });

  it("dedupes across turns via the session file and re-injects nothing when exhausted", async () => {
    seedRecords(4);
    await t.run("user-prompt-submit", payload("sqlite question one"));
    await t.run("user-prompt-submit", payload("sqlite question two"));
    // 4 records, 3 injected on turn one, 1 on turn two — turn three has nothing new.
    await t.run("user-prompt-submit", payload("sqlite question three"));

    expect(t.emitted).toHaveLength(2);
    const first = additionalContext(t.emitted[0]) as string;
    const second = additionalContext(t.emitted[1]) as string;
    expect((second.match(/\[decision\]/g) ?? []).length).toBe(1);
    for (const line of second.split("\n")) {
      if (line.startsWith("[decision]")) {
        expect(first).not.toContain(line);
      }
    }

    const ids = JSON.parse(readFileSync(dedupFilePath(t.env.tmpDir, "sess-1"), "utf8")) as string[];
    expect(ids).toHaveLength(4);
  });

  it("degrades a corrupt dedup file to re-injection, never an error", async () => {
    seedRecords(2);
    writeFileSync(dedupFilePath(t.env.tmpDir, "sess-1"), "corrupt!!", "utf8");
    expect(await t.run("user-prompt-submit", payload("sqlite"))).toBe(0);
    expect(t.emitted).toHaveLength(1);
  });

  it("stays within the per-turn budgets even with maximum-size records", async () => {
    const db = t.openDb();
    try {
      for (let i = 0; i < 3; i++) {
        insertRecord(db, {
          projectId: t.projectId,
          type: "discovery",
          title: `Giant discovery ${i} about budgets`,
          body: `budgets ${"x".repeat(1980)}`,
          source: "cli",
        });
      }
    } finally {
      db.close();
    }
    await t.run("user-prompt-submit", payload("tell me about budgets"));

    const ctx = additionalContext(t.emitted[0]) as string;
    expect(ctx.length).toBeLessThanOrEqual(PROMPT_SUBMIT_MAX_CHARS);
    expect(estimateTokens(ctx)).toBeLessThanOrEqual(PROMPT_SUBMIT_MAX_TOKENS);
  });

  it("marks inferred records as unconfirmed (SPEC §3.3)", async () => {
    const db = t.openDb();
    try {
      insertRecord(db, {
        projectId: t.projectId,
        type: "preference",
        title: "Prefers tabs",
        body: "Developer seems to prefer tabs over spaces.",
        source: "hook_observation",
        confidence: "inferred",
      });
    } finally {
      db.close();
    }
    await t.run("user-prompt-submit", payload("tabs or spaces?"));
    expect(additionalContext(t.emitted[0])).toContain("(unconfirmed pattern)");
  });

  it("records its token estimate in sessions.tokens_injected", async () => {
    seedRecords(2);
    await t.run("user-prompt-submit", payload("sqlite"));

    const db = t.openDb();
    try {
      const row = db
        .prepare("SELECT tokens_injected FROM sessions WHERE session_id = ?")
        .get("sess-1") as { tokens_injected: number };
      expect(row.tokens_injected).toBe(estimateTokens(additionalContext(t.emitted[0]) as string));
    } finally {
      db.close();
    }
  });

  it("emits nothing for an empty prompt, no matches, or a missing database", async () => {
    expect(await t.run("user-prompt-submit", payload("anything"))).toBe(0); // no db
    t.openDb().close();
    expect(await t.run("user-prompt-submit", payload(""))).toBe(0);
    expect(await t.run("user-prompt-submit", payload("no records match this"))).toBe(0);
    expect(t.emitted).toEqual([]);
  });
});

describe("formatInjection budget enforcement", () => {
  const hit = (id: string, bodyLength: number): SearchHit => ({
    record: {
      id,
      projectId: "p",
      type: "decision",
      title: `Record ${id}`,
      body: "b".repeat(bodyLength),
      scope: "project",
      pinned: false,
      confidence: "explicit",
      reinforceCount: 0,
      validFrom: "2026-01-01T00:00:00Z",
      recordedAt: "2026-01-01T00:00:00Z",
      supersededAt: null,
      supersededBy: null,
      accessCount: 0,
      lastAccessed: null,
      score: 1,
      claudemdDriftScore: 0,
      source: "cli",
      sessionId: null,
      pendingEmbedding: true,
    } satisfies ContextRecord,
    relevance: 1,
  });

  it("drops the lowest-ranked records first when a budget would overflow", () => {
    const hits = [hit("a", 100), hit("b", 100), hit("c", 100)];
    const result = formatInjection(hits, 2000, 300);
    expect(result.ids).toEqual(["a", "b"]);
    expect(result.text.length).toBeLessThanOrEqual(300);
  });

  it("enforces the token budget independently of the char budget", () => {
    const hits = [hit("a", 800), hit("b", 800)];
    const result = formatInjection(hits, 250, 100000);
    expect(result.ids).toEqual(["a"]);
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(250);
  });

  it("skips an oversized higher-ranked record and still injects lower-ranked ones", () => {
    const hits = [hit("a", 2000), hit("b", 100), hit("c", 100)];
    const result = formatInjection(hits, 2000, 400);
    expect(result.ids).toEqual(["b", "c"]);
    expect(result.text.length).toBeLessThanOrEqual(400);
  });

  it("returns empty when nothing fits", () => {
    const result = formatInjection([hit("a", 500)], 10, 8000);
    expect(result).toEqual({ text: "", ids: [], tokens: 0 });
  });
});
