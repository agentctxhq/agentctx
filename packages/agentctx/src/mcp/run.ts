/**
 * `agentctx mcp` — the stdio MCP server entry (SPEC §5), registered at user
 * scope by `agentctx init` (claude/mcp.ts). One process per Claude Code
 * session: serve over stdio until the client closes stdin, then exit
 * (Invariant 1: short-lived, no daemon).
 */
import type { CliEnv } from "../cli/env.js";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import { serveMcp } from "./server.js";
import { toolDefinitions } from "./tools.js";

export async function runMcp(env: CliEnv, _args: string[]): Promise<number> {
  const db = openDatabase(env.dbPath);
  try {
    await serveMcp({
      input: process.stdin,
      output: process.stdout,
      context: { db, projectId: resolveProjectId(env.cwd), cwd: env.cwd },
      tools: toolDefinitions(),
      logError: (message) => env.io.err(message),
    });
  } finally {
    db.close();
  }
  return 0;
}
