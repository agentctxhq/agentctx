/**
 * `agentctx extract --session-id <id> --transcript <path>` (SPEC §6, ADR-009).
 *
 * Spawned detached by the Stop hook. Failure policy: extraction failures are
 * logged to ~/.agentctx/logs/extract.log and exit 0 — they MUST never
 * surface as session errors (SPEC §6). Only direct-CLI argument misuse
 * exits non-zero.
 *
 * Degradation (SPEC §8 rung 3): no API key or `llm: false` in config →
 * exit cleanly without calling the API; deterministic capture still stands.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { CliEnv } from "../cli/env.js";
import { loadConfig } from "../config.js";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import { type FetchLike, requestCompletion } from "./api.js";
import { type IngestStats, ingestExtraction } from "./ingest.js";
import { EXTRACTION_SYSTEM_PROMPT, SYNTHESIS_SYSTEM_PROMPT } from "./prompt.js";
import { parseExtraction } from "./schema.js";
import { parseTranscript, renderTurns, selectExtractionInput } from "./transcript.js";

export interface ExtractDeps {
  fetchFn: FetchLike;
  /** API key detection (OQ-2): undefined → degrade, never error. */
  apiKey: string | undefined;
}

function defaultDeps(): ExtractDeps {
  return {
    fetchFn: (input, init) => fetch(input, init),
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
}

export async function runExtract(
  env: CliEnv,
  args: string[],
  deps: ExtractDeps = defaultDeps(),
): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      "session-id": { type: "string" },
      transcript: { type: "string" },
      "no-llm": { type: "boolean", default: false },
    },
  });
  const sessionId = values["session-id"];
  const transcriptPath = values.transcript;
  if (sessionId === undefined || transcriptPath === undefined) {
    env.io.err("agentctx extract: --session-id and --transcript are required");
    return 1;
  }

  const log = makeLog(env);
  try {
    return await extract(env, sessionId, transcriptPath, values["no-llm"] === true, deps, log);
  } catch (error) {
    log(`extract failed for session ${sessionId}: ${describe(error)}`);
    return 0; // never a session error (SPEC §6)
  }
}

async function extract(
  env: CliEnv,
  sessionId: string,
  transcriptPath: string,
  noLlm: boolean,
  deps: ExtractDeps,
  log: (message: string) => void,
): Promise<number> {
  if (noLlm || !loadConfigLenient(env).llm) {
    return 0; // deterministic capture only (SPEC §8 rung 3)
  }
  if (deps.apiKey === undefined || deps.apiKey.length === 0) {
    log(`extract: no ANTHROPIC_API_KEY — skipping LLM extraction for session ${sessionId}`);
    return 0;
  }

  const turns = parseTranscript(readFileSync(transcriptPath, "utf8"));
  if (turns.length === 0) {
    return 0;
  }

  const input = selectExtractionInput(renderTurns(turns));
  let totalCost = 0;
  let responseText: string;

  if (input.mode === "map-reduce") {
    // Known v0.1 limitation: if any parallel chunk call fails, the whole
    // extraction is abandoned and the cost of the chunks that did complete
    // is not recorded in sessions.extraction_cost_usd.
    const chunkResponses = await Promise.all(
      input.chunks.map((chunk) =>
        requestCompletion(deps.fetchFn, deps.apiKey as string, EXTRACTION_SYSTEM_PROMPT, chunk),
      ),
    );
    totalCost += chunkResponses.reduce((sum, r) => sum + r.costUsd, 0);
    const synthesis = await requestCompletion(
      deps.fetchFn,
      deps.apiKey,
      SYNTHESIS_SYSTEM_PROMPT,
      chunkResponses.map((r, i) => `Chunk ${i + 1} extraction:\n${r.text}`).join("\n\n"),
    );
    totalCost += synthesis.costUsd;
    responseText = synthesis.text;
  } else {
    const response = await requestCompletion(
      deps.fetchFn,
      deps.apiKey,
      EXTRACTION_SYSTEM_PROMPT,
      input.text,
    );
    totalCost += response.costUsd;
    responseText = response.text;
  }

  const db = openDatabase(env.dbPath);
  try {
    const projectId = sessionProjectId(db, sessionId) ?? resolveProjectId(env.cwd);
    recordCost(db, sessionId, projectId, totalCost);
    const result = parseExtraction(responseText);
    if (result === null) {
      log(`extract: unparseable model output for session ${sessionId} — skipped`);
      return 0;
    }
    const stats = ingestExtraction(db, projectId, sessionId, result, log);
    logStats(log, sessionId, stats, totalCost, result.flushOk);
  } finally {
    db.close();
  }
  return 0;
}

/**
 * Self-accounting (SPEC §3.1, §7): cost lands on the session row, attributed to
 * its project. When the cost row is the session's first DB write (a sparse
 * session that never triggered a SessionStart/UserPromptSubmit injection),
 * `project_id` would otherwise stay NULL and `status` would drop the cost from
 * the per-project total. Fill it here, but never clobber a value an injection
 * already set.
 */
function recordCost(
  db: ReturnType<typeof openDatabase>,
  sessionId: string,
  projectId: string,
  cost: number,
): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project_id, extraction_cost_usd)
       VALUES (@sessionId, @projectId, @cost)
     ON CONFLICT(session_id) DO UPDATE SET
       extraction_cost_usd = extraction_cost_usd + @cost,
       project_id = COALESCE(project_id, @projectId)`,
  ).run({ sessionId, projectId, cost });
}

function sessionProjectId(db: ReturnType<typeof openDatabase>, sessionId: string): string | null {
  const row = db.prepare("SELECT project_id FROM sessions WHERE session_id = ?").get(sessionId) as
    | { project_id: string | null }
    | undefined;
  return row?.project_id ?? null;
}

function logStats(
  log: (message: string) => void,
  sessionId: string,
  stats: IngestStats,
  cost: number,
  flushOk: boolean,
): void {
  log(
    `extract: session ${sessionId} — ${flushOk ? "flush_ok, " : ""}` +
      `${stats.written} written, ${stats.dropped} dropped, ${stats.reinforced} reinforced, ` +
      `$${cost.toFixed(4)}`,
  );
}

function loadConfigLenient(env: CliEnv): { llm: boolean } {
  try {
    return loadConfig(env.configPath);
  } catch {
    return { llm: true };
  }
}

/** Log to the extract log file and stderr; both are best-effort. */
function makeLog(env: CliEnv): (message: string) => void {
  return (message) => {
    try {
      const dir = join(env.agentctxHome, "logs");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "extract.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
    } catch {
      /* logging must never become a failure */
    }
    try {
      env.io.err(message);
    } catch {
      /* stderr is ignored when running detached */
    }
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
