/**
 * Lifecycle hooks that delegate to detached subprocesses or do single-row
 * bookkeeping (SPEC §4):
 *
 * - Stop       → spawn `agentctx extract …` detached, return immediately
 * - SessionEnd → mark the session ended, drop the dedup file, spawn
 *                `agentctx consolidate` detached
 * - CwdChanged → switch the session's active project namespace
 *
 * The `extract` and `consolidate` subcommands land in issue 4/7; until then
 * the detached child exits non-zero in the background, which is invisible
 * to the session by construction (detached, stdio ignored).
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG, loadConfig } from "../config.js";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import { dedupFilePath } from "./dedup.js";
import type { HookEnv } from "./env.js";
import type { HookPayload } from "./payload.js";
import { markSessionEnded, setSessionProject } from "./sessions.js";

export async function runStop(env: HookEnv, payload: HookPayload): Promise<void> {
  if (payload.sessionId === null || payload.transcriptPath === null) {
    return;
  }
  // `--no-llm` (SPEC §8 rung 3): deterministic capture only — skip extraction.
  if (!effectiveConfig(env).llm) {
    return;
  }
  env.spawnDetached([
    "extract",
    "--session-id",
    payload.sessionId,
    "--transcript",
    payload.transcriptPath,
  ]);
}

export async function runSessionEnd(env: HookEnv, payload: HookPayload): Promise<void> {
  if (payload.sessionId !== null) {
    // The dedup file is disposable derived state (SPEC §7); the session is over.
    try {
      rmSync(dedupFilePath(env.tmpDir, payload.sessionId), { force: true });
    } catch {
      /* tmp cleanup is best-effort */
    }
    if (existsSync(env.dbPath)) {
      try {
        const db = openDatabase(env.dbPath);
        try {
          markSessionEnded(db, payload.sessionId, env.now().toISOString());
        } finally {
          db.close();
        }
      } catch (error) {
        env.log(`session-end: bookkeeping failed: ${describe(error)}`);
      }
    }
  }
  env.spawnDetached(["consolidate"]);
}

export async function runCwdChanged(env: HookEnv, payload: HookPayload): Promise<void> {
  if (payload.sessionId === null || payload.cwd === null || !existsSync(env.dbPath)) {
    return;
  }
  const projectId = resolveProjectId(payload.cwd);
  const db = openDatabase(env.dbPath);
  try {
    setSessionProject(db, payload.sessionId, projectId);
  } finally {
    db.close();
  }
}

/** Config load is lenient here: a corrupt config file must not break hooks. */
function effectiveConfig(env: HookEnv): { llm: boolean } {
  try {
    return loadConfig(join(env.agentctxHome, CONFIG_FILE_NAME));
  } catch {
    return DEFAULT_CONFIG;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
