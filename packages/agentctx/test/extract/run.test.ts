import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveConfig } from "../../src/config.js";
import type { FetchLike } from "../../src/extract/api.js";
import { runExtract } from "../../src/extract/run.js";
import { CHARS_PER_TOKEN } from "../../src/hooks/tokens.js";
import { openDatabase } from "../../src/storage/db.js";
import { resolveProjectId } from "../../src/storage/namespace.js";
import { listRecords } from "../../src/storage/records.js";
import { type TestEnv, makeTestEnv } from "../cli/helpers.js";

const EXTRACTION = {
  decisions: [
    { what: "Use SQLite", rationale: "No daemon", supersedes: null, confidence: "explicit" },
  ],
  preferences: [],
  conventions: [],
  active_work: { current_task: "", blockers: [], next_steps: [], open_questions: [] },
  gotchas: [],
  flush_ok: false,
};

const USAGE = {
  input_tokens: 1_000,
  output_tokens: 500,
  cache_creation_input_tokens: 2_000,
  cache_read_input_tokens: 0,
};
// 1000×$1 + 500×$5 + 2000×$1.25 per MTok
const EXPECTED_COST = (1_000 * 1 + 500 * 5 + 2_000 * 1.25) / 1_000_000;

interface MockCall {
  url: string;
  body: Record<string, unknown>;
}

function mockFetch(
  calls: MockCall[],
  respond: (body: Record<string, unknown>) => Response = () => apiResponse(EXTRACTION),
): FetchLike {
  return async (url, init) => {
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    calls.push({ url, body });
    return respond(body);
  };
}

function apiResponse(extraction: unknown): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(extraction) }],
      usage: USAGE,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("agentctx extract", () => {
  let t: TestEnv;
  let transcriptPath: string;

  beforeEach(() => {
    t = makeTestEnv();
    transcriptPath = join(t.root, "transcript.jsonl");
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "user", message: { content: "let's use SQLite, no daemon" } })}\n`,
      "utf8",
    );
  });

  afterEach(() => t.cleanup());

  function run(deps: { fetchFn: FetchLike; apiKey: string | undefined }, args: string[] = []) {
    return runExtract(t.env, ["--session-id", "s1", "--transcript", transcriptPath, ...args], deps);
  }

  it("requires --session-id and --transcript", async () => {
    expect(await runExtract(t.env, [], { fetchFn: mockFetch([]), apiKey: "k" })).toBe(1);
  });

  it("extracts records and records the session cost", async () => {
    const calls: MockCall[] = [];
    expect(await run({ fetchFn: mockFetch(calls), apiKey: "key" })).toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toBe("claude-haiku-4-5");
    // Prompt-caching breakpoint on the system prompt (ADR-009).
    const system = calls[0]?.body.system as Array<Record<string, unknown>>;
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });

    const db = openDatabase(t.env.dbPath);
    try {
      const records = listRecords(db, resolveProjectId(t.env.cwd));
      expect(records).toHaveLength(1);
      expect(records[0]?.title).toBe("Use SQLite");
      const session = db
        .prepare("SELECT extraction_cost_usd FROM sessions WHERE session_id = 's1'")
        .get() as { extraction_cost_usd: number };
      expect(session.extraction_cost_usd).toBeCloseTo(EXPECTED_COST, 10);
    } finally {
      db.close();
    }
  });

  it("degrades cleanly without an API key (SPEC §8 rung 3)", async () => {
    const calls: MockCall[] = [];
    expect(await run({ fetchFn: mockFetch(calls), apiKey: undefined })).toBe(0);
    expect(calls).toHaveLength(0);
    expect(existsSync(t.env.dbPath)).toBe(false);
  });

  it("skips extraction when llm is off in config", async () => {
    saveConfig(t.env.configPath, { llm: false });
    const calls: MockCall[] = [];
    expect(await run({ fetchFn: mockFetch(calls), apiKey: "key" })).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("skips extraction with --no-llm", async () => {
    const calls: MockCall[] = [];
    expect(await run({ fetchFn: mockFetch(calls), apiKey: "key" }, ["--no-llm"])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("writes nothing on flush_ok but still records the cost", async () => {
    const calls: MockCall[] = [];
    const flushOk = mockFetch(calls, () => apiResponse({ flush_ok: true }));
    expect(await run({ fetchFn: flushOk, apiKey: "key" })).toBe(0);

    const db = openDatabase(t.env.dbPath);
    try {
      expect(listRecords(db, resolveProjectId(t.env.cwd))).toHaveLength(0);
      const session = db
        .prepare("SELECT extraction_cost_usd FROM sessions WHERE session_id = 's1'")
        .get() as { extraction_cost_usd: number };
      expect(session.extraction_cost_usd).toBeCloseTo(EXPECTED_COST, 10);
    } finally {
      db.close();
    }
  });

  it("logs API failures and exits 0 — never a session error (SPEC §6)", async () => {
    const failing: FetchLike = async () => new Response("overloaded", { status: 529 });
    expect(await run({ fetchFn: failing, apiKey: "key" })).toBe(0);
    const log = readFileSync(join(t.env.agentctxHome, "logs", "extract.log"), "utf8");
    expect(log).toContain("extract failed for session s1");
    expect(log).toContain("529");
  });

  it("logs and exits 0 on unparseable model output", async () => {
    const garbage = mockFetch(
      [],
      () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "not json at all" }], usage: USAGE }),
          { status: 200 },
        ),
    );
    expect(await run({ fetchFn: garbage, apiKey: "key" })).toBe(0);
    const log = readFileSync(join(t.env.agentctxHome, "logs", "extract.log"), "utf8");
    expect(log).toContain("unparseable model output");
  });

  it("map-reduces >50K-token transcripts: chunk calls plus one synthesis", async () => {
    // A transcript whose rendered size crosses the 50K-token threshold.
    const bigText = "z".repeat(55_000 * CHARS_PER_TOKEN);
    writeFileSync(
      transcriptPath,
      `${JSON.stringify({ type: "user", message: { content: bigText } })}\n`,
      "utf8",
    );
    const calls: MockCall[] = [];
    expect(await run({ fetchFn: mockFetch(calls), apiKey: "key" })).toBe(0);
    expect(calls.length).toBeGreaterThan(2); // ≥ 2 chunks + 1 synthesis

    const synthesis = calls[calls.length - 1];
    const messages = synthesis?.body.messages as Array<{ content: string }>;
    expect(messages[0]?.content).toContain("Chunk 1 extraction:");

    const db = openDatabase(t.env.dbPath);
    try {
      const session = db
        .prepare("SELECT extraction_cost_usd FROM sessions WHERE session_id = 's1'")
        .get() as { extraction_cost_usd: number };
      expect(session.extraction_cost_usd).toBeCloseTo(EXPECTED_COST * calls.length, 10);
    } finally {
      db.close();
    }
  });
});
