import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import type { HookEnv } from "../../src/hooks/env.js";
import { runHook } from "../../src/hooks/runner.js";
import { openDatabase } from "../../src/storage/db.js";
import { resolveProjectId } from "../../src/storage/namespace.js";

export interface HookTestEnv {
  env: HookEnv;
  root: string;
  /** A non-git project dir — projectId falls back to the path hash. */
  cwd: string;
  projectId: string;
  /** JSON objects written via env.emit, in order. */
  emitted: unknown[];
  /** Argument vectors passed to spawnDetached, in order. */
  spawns: string[][];
  logs: string[];
  /** Set the raw stdin body for the next runHook call. */
  setStdin(raw: string): void;
  /** Run an event with a payload object (JSON-encoded onto stdin). */
  run(event: string, payload?: Record<string, unknown>): Promise<number>;
  /** Open the env's database (creating it), as a hook would see it. */
  openDb(): Database;
  cleanup(): void;
}

export function makeHookEnv(): HookTestEnv {
  const root = mkdtempSync(join(tmpdir(), "agentctx-hooks-"));
  const cwd = join(root, "project");
  const agentctxHome = join(root, "agentctx-home");
  const hookTmpDir = join(root, "tmp");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(hookTmpDir, { recursive: true });

  const emitted: unknown[] = [];
  const spawns: string[][] = [];
  const logs: string[] = [];
  let stdinBody = "";

  const env: HookEnv = {
    cwd,
    agentctxHome,
    dbPath: join(agentctxHome, "agentctx.db"),
    tmpDir: hookTmpDir,
    readStdin: async () => stdinBody,
    emit: (output) => emitted.push(output),
    spawnDetached: (args) => spawns.push(args),
    log: (message) => logs.push(message),
    now: () => new Date(),
  };

  return {
    env,
    root,
    cwd,
    projectId: resolveProjectId(cwd),
    emitted,
    spawns,
    logs,
    setStdin: (raw) => {
      stdinBody = raw;
    },
    run: (event, payload) => {
      stdinBody = payload === undefined ? "" : JSON.stringify(payload);
      return runHook(event, env);
    },
    openDb: () => openDatabase(env.dbPath),
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

/** The additionalContext string from an emitted hook output, or null. */
export function additionalContext(output: unknown): string | null {
  if (typeof output !== "object" || output === null) {
    return null;
  }
  const hso = (output as Record<string, unknown>).hookSpecificOutput;
  if (typeof hso !== "object" || hso === null) {
    return null;
  }
  const ctx = (hso as Record<string, unknown>).additionalContext;
  return typeof ctx === "string" ? ctx : null;
}
