/**
 * SessionStart hook (SPEC §4, ADR-007 Tier 1): read the pre-computed digest
 * file and emit it as `additionalContext`, hard-capped at 1,500 tokens.
 *
 * The digest is NEVER computed inline — `agentctx consolidate` (issue 4/7)
 * writes it at SessionEnd. Before the first consolidation pass runs, the
 * issue 3/7 contract allows a minimal profile-only digest: a single indexed
 * read of the keyed `profile` records, not a digest computation.
 *
 * Resume (`source: "resume"`) intentionally re-emits: SessionStart is the
 * reliable injection point on resume (ADR-001), and re-injection is
 * re-counted in `sessions.tokens_injected` because it is re-paid.
 */
import { existsSync } from "node:fs";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import { listRecords } from "../storage/records.js";
import { composeDigest, digestFilePath, readDigestFile } from "./digest.js";
import type { HookEnv } from "./env.js";
import type { HookPayload } from "./payload.js";
import { recordInjection } from "./sessions.js";
import { estimateTokens, truncateToTokens } from "./tokens.js";

/** Budget for the first-run profile-only fallback (the digest's profile slot). */
const FALLBACK_PROFILE_MAX_TOKENS = 200;

export async function runSessionStart(env: HookEnv, payload: HookPayload): Promise<void> {
  const cwd = payload.cwd ?? env.cwd;
  const projectId = resolveProjectId(cwd);

  const digest = readDigestFile(digestFilePath(env.agentctxHome, projectId));
  const text =
    digest !== null ? composeDigest(digest.sections) : profileOnlyFallback(env, projectId);
  if (text.length === 0) {
    return;
  }

  env.emit({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  });
  accountInjection(env, payload.sessionId, projectId, estimateTokens(text));
}

function profileOnlyFallback(env: HookEnv, projectId: string): string {
  if (!existsSync(env.dbPath)) {
    return "";
  }
  try {
    const db = openDatabase(env.dbPath);
    try {
      const profiles = listRecords(db, projectId, { type: "profile" });
      if (profiles.length === 0) {
        return "";
      }
      const lines = profiles
        .filter((r) => r.projectId === projectId)
        .map((r) => `- ${r.title}: ${r.body}`)
        .reverse(); // listRecords is newest-first; keep detection order (Stack, Commands, …)
      if (lines.length === 0) {
        return "";
      }
      const text = `Project profile (agentctx):\n${lines.join("\n")}`;
      return truncateToTokens(text, FALLBACK_PROFILE_MAX_TOKENS);
    } finally {
      db.close();
    }
  } catch (error) {
    env.log(`session-start: profile fallback failed: ${describe(error)}`);
    return "";
  }
}

/** Self-accounting (SPEC §9). Failures are logged and swallowed — the injection already happened. */
function accountInjection(
  env: HookEnv,
  sessionId: string | null,
  projectId: string,
  tokens: number,
): void {
  if (sessionId === null || !existsSync(env.dbPath)) {
    return;
  }
  try {
    const db = openDatabase(env.dbPath);
    try {
      recordInjection(db, { sessionId, projectId, tokens, at: env.now().toISOString() });
    } finally {
      db.close();
    }
  } catch (error) {
    env.log(`session-start: token accounting failed: ${describe(error)}`);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
