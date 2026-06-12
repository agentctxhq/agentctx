/**
 * End-to-end hardening (issue 7/7): the full v0.1 loop against one store —
 *
 *   init → simulated session (hook invocations with fixture payloads)
 *        → extract (mocked Anthropic API) → consolidate
 *        → next SessionStart digest carries the handover and decisions
 *
 * with the invariant audit alongside: budgets never exceeded, superseded
 * records never surfacing, no-API-key degradation (OQ-2), and concurrent
 * writers staying safe under WAL.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "../src/cli/init.js";
import { runConsolidate } from "../src/consolidate/run.js";
import { PRICE_PER_MTOK } from "../src/extract/api.js";
import { runExtract } from "../src/extract/run.js";
import { SESSION_START_MAX_TOKENS } from "../src/hooks/digest.js";
import type { HookEnv } from "../src/hooks/env.js";
import { runHook } from "../src/hooks/runner.js";
import { estimateTokens } from "../src/hooks/tokens.js";
import {
  PROMPT_SUBMIT_MAX_CHARS,
  PROMPT_SUBMIT_MAX_TOKENS,
} from "../src/hooks/user-prompt-submit.js";
import { openDatabase } from "../src/storage/db.js";
import { resolveProjectId } from "../src/storage/namespace.js";
import { insertRecord } from "../src/storage/records.js";
import { type TestEnv, makeTestEnv } from "./cli/helpers.js";

let t: TestEnv;
let hookEnv: HookEnv;
let emitted: unknown[];
let spawns: string[][];
let projectId: string;

beforeEach(() => {
  t = makeTestEnv();
  projectId = resolveProjectId(t.env.cwd);
  emitted = [];
  spawns = [];
  mkdirSync(join(t.root, "tmp"), { recursive: true });
  hookEnv = {
    cwd: t.env.cwd,
    agentctxHome: t.env.agentctxHome,
    dbPath: t.env.dbPath,
    tmpDir: join(t.root, "tmp"),
    readStdin: async () => "",
    emit: (output) => emitted.push(output),
    spawnDetached: (args) => spawns.push(args),
    log: () => {},
    now: () => new Date(),
  };
  // A recognizable project manifest so init's profile detection has material.
  writeFileSync(
    join(t.env.cwd, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      scripts: { test: "vitest run", build: "tsc" },
      dependencies: { hono: "^4.0.0" },
      devDependencies: { vitest: "^2.0.0" },
    }),
  );
});

afterEach(() => t.cleanup());

async function hook(event: string, payload: Record<string, unknown>): Promise<number> {
  const env = { ...hookEnv, readStdin: async () => JSON.stringify(payload) };
  return runHook(event, env);
}

/** The additionalContext of the last emitted hook output, or null. */
function lastContext(): string | null {
  const output = emitted[emitted.length - 1] as
    | { hookSpecificOutput?: { additionalContext?: unknown } }
    | undefined;
  const ctx = output?.hookSpecificOutput?.additionalContext;
  return typeof ctx === "string" ? ctx : null;
}

function writeTranscript(name: string, lines: Array<Record<string, unknown>>): string {
  const path = join(t.root, name);
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"), "utf8");
  return path;
}

const FIXTURE_TRANSCRIPT = [
  { type: "user", message: { content: "Let's use vitest as our test runner going forward." } },
  { type: "assistant", message: { content: [{ type: "text", text: "Done — vitest it is." }] } },
];

function extractionApiResponse(extraction: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(extraction) }],
      usage: { input_tokens: 2000, output_tokens: 300 },
    }),
    { status: 200 },
  );
}

const SESSION_ONE_EXTRACTION = {
  decisions: [
    {
      what: "Use vitest as the test runner",
      rationale: "ESM-native and fast",
      supersedes: null,
      confidence: "explicit",
    },
  ],
  preferences: [
    {
      category: "process",
      rule: "Prefers conventional commit messages",
      confidence: "explicit",
      scope: "global",
    },
  ],
  conventions: [],
  active_work: {
    current_task: "Finishing the v0.1 CLI surface",
    blockers: [],
    next_steps: ["Ship agentctx status", "Cut the 0.1.0 release"],
    open_questions: [],
  },
  gotchas: [],
  flush_ok: false,
};

describe("v0.1 end to end", () => {
  it("init → session → extract → consolidate → next SessionStart digest", async () => {
    // --- init -------------------------------------------------------------
    expect(await runInit(t.env, [])).toBe(0);

    // --- session 1: hooks fire with fixture payloads -----------------------
    const sid = "e2e-session-1";
    expect(
      await hook("session-start", { session_id: sid, cwd: t.env.cwd, source: "startup" }),
    ).toBe(0); // cold start: no digest yet, nothing injected — and no error

    // UserPromptSubmit: FTS5 over the literal prompt finds the detected profile.
    await hook("user-prompt-submit", {
      session_id: sid,
      cwd: t.env.cwd,
      prompt: "what test commands does this project use?",
    });
    const injected = lastContext();
    expect(injected).not.toBeNull();
    expect(estimateTokens(injected ?? "")).toBeLessThanOrEqual(PROMPT_SUBMIT_MAX_TOKENS);
    expect((injected ?? "").length).toBeLessThanOrEqual(PROMPT_SUBMIT_MAX_CHARS);

    // Same prompt again in the same session: dedup keeps it silent.
    const emittedBefore = emitted.length;
    await hook("user-prompt-submit", {
      session_id: sid,
      cwd: t.env.cwd,
      prompt: "what test commands does this project use?",
    });
    expect(emitted.length).toBe(emittedBefore);

    // Stop spawns the detached extraction subprocess...
    const transcript = writeTranscript("transcript-1.jsonl", FIXTURE_TRANSCRIPT);
    await hook("stop", { session_id: sid, transcript_path: transcript, cwd: t.env.cwd });
    expect(spawns).toContainEqual(["extract", "--session-id", sid, "--transcript", transcript]);

    // ...which we run inline with a mocked API (the spawn args above).
    const calls: string[] = [];
    expect(
      await runExtract(t.env, ["--session-id", sid, "--transcript", transcript], {
        apiKey: "test-key",
        fetchFn: async (url) => {
          calls.push(url);
          return extractionApiResponse(SESSION_ONE_EXTRACTION);
        },
      }),
    ).toBe(0);
    expect(calls).toHaveLength(1);

    // SessionEnd marks the session and hands off to consolidate.
    await hook("session-end", { session_id: sid, cwd: t.env.cwd });
    expect(spawns).toContainEqual(["consolidate"]);
    expect(await runConsolidate(t.env, [])).toBe(0);

    // --- session 2: the digest knows where we left off ---------------------
    emitted.length = 0;
    await hook("session-start", { session_id: "e2e-session-2", cwd: t.env.cwd, source: "startup" });
    const digest = lastContext();
    expect(digest).not.toBeNull();
    expect(digest).toContain("Finishing the v0.1 CLI surface"); // handover
    expect(digest).toContain("Use vitest as the test runner"); // decision
    expect(digest).toContain("Prefers conventional commit messages"); // global preference
    expect(estimateTokens(digest ?? "")).toBeLessThanOrEqual(SESSION_START_MAX_TOKENS);

    // --- self-accounting (SPEC §9): the tax we imposed is on the record ----
    const db = openDatabase(t.env.dbPath);
    try {
      const session = db
        .prepare("SELECT tokens_injected, extraction_cost_usd FROM sessions WHERE session_id = ?")
        .get(sid) as { tokens_injected: number; extraction_cost_usd: number };
      expect(session.tokens_injected).toBeGreaterThan(0);
      // Cost of the mocked usage block (2000 in / 300 out), priced by the
      // same constants the extractor uses.
      const expectedCost = (2000 * PRICE_PER_MTOK.input + 300 * PRICE_PER_MTOK.output) / 1_000_000;
      expect(session.extraction_cost_usd).toBeCloseTo(expectedCost, 6);
    } finally {
      db.close();
    }
  });

  it("a new handover supersedes the old one — the digest never shows stale state", async () => {
    await runInit(t.env, ["--no-mcp"]);
    const transcript = writeTranscript("transcript-2.jsonl", FIXTURE_TRANSCRIPT);

    for (const [sid, task] of [
      ["s-old", "Old task from last week"],
      ["s-new", "Brand new task"],
    ] as const) {
      await runExtract(t.env, ["--session-id", sid, "--transcript", transcript], {
        apiKey: "test-key",
        fetchFn: async () =>
          extractionApiResponse({
            ...SESSION_ONE_EXTRACTION,
            decisions: [],
            preferences: [],
            active_work: { ...SESSION_ONE_EXTRACTION.active_work, current_task: task },
          }),
      });
    }
    await runConsolidate(t.env, []);

    await hook("session-start", { session_id: "s-3", cwd: t.env.cwd, source: "startup" });
    const digest = lastContext();
    expect(digest).toContain("Brand new task");
    expect(digest).not.toContain("Old task from last week");
  });

  it("degrades end to end without an API key (OQ-2): deterministic capture keeps working", async () => {
    await runInit(t.env, ["--no-mcp"]);
    const transcript = writeTranscript("transcript-3.jsonl", FIXTURE_TRANSCRIPT);

    // No key: extraction exits 0 without ever touching the network.
    expect(
      await runExtract(t.env, ["--session-id", "s-nokey", "--transcript", transcript], {
        apiKey: undefined,
        fetchFn: async () => {
          throw new Error("network must not be touched without an API key");
        },
      }),
    ).toBe(0);

    const db = openDatabase(t.env.dbPath);
    try {
      const llmRecords = db
        .prepare("SELECT COUNT(*) AS n FROM records WHERE source = 'llm_extraction'")
        .get() as { n: number };
      expect(llmRecords.n).toBe(0);
    } finally {
      db.close();
    }

    // Injection and the digest still work over what deterministic capture has
    // (SPEC §8 rung 3): the init-detected project profile.
    await runConsolidate(t.env, []);
    await hook("session-start", { session_id: "s-after", cwd: t.env.cwd, source: "startup" });
    const digest = lastContext();
    expect(digest).not.toBeNull();
    expect(digest).toContain("Project profile");
    expect(estimateTokens(digest ?? "")).toBeLessThanOrEqual(SESSION_START_MAX_TOKENS);
  });

  it("hooks never error into the session, even against a missing or broken store", async () => {
    // No init at all — every event must still exit 0 with no output.
    for (const event of ["session-start", "user-prompt-submit", "stop", "session-end"]) {
      expect(await hook(event, { session_id: "s", cwd: t.env.cwd, prompt: "x" })).toBe(0);
    }
    // Corrupt database file: same contract.
    mkdirSync(t.env.agentctxHome, { recursive: true });
    writeFileSync(t.env.dbPath, "this is not a sqlite database");
    for (const event of ["session-start", "user-prompt-submit", "session-end"]) {
      expect(await hook(event, { session_id: "s", cwd: t.env.cwd, prompt: "x" })).toBe(0);
    }
  });

  it("concurrent hook writers are safe under WAL", async () => {
    await runInit(t.env, ["--no-mcp", "--no-profile"]);
    // Hooks are separate short-lived processes — model them as independent
    // connections interleaving writes while a reader stays open.
    const writers = [openDatabase(t.env.dbPath), openDatabase(t.env.dbPath)];
    const reader = openDatabase(t.env.dbPath);
    try {
      for (let i = 0; i < 20; i++) {
        const db = writers[i % writers.length];
        if (db === undefined) throw new Error("unreachable");
        insertRecord(db, {
          projectId,
          type: "discovery",
          title: `Concurrent observation ${i}`,
          body: "Written while another connection was active.",
          source: "hook_observation",
        });
        reader.prepare("SELECT COUNT(*) AS n FROM records").get();
      }
      const count = reader.prepare("SELECT COUNT(*) AS n FROM records").get() as { n: number };
      expect(count.n).toBe(20);
    } finally {
      for (const db of [...writers, reader]) db.close();
    }
  });
});
