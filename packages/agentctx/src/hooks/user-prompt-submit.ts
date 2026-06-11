/**
 * UserPromptSubmit hook (SPEC §4, ADR-007 Tier 2): FTS5 BM25 search on the
 * literal prompt → recency/type/pinning rerank (the search module's job) →
 * session dedup → inject top-3 under hard budgets → append injected IDs to
 * the dedup file and account the tokens.
 *
 * Latency target ≤ 150 ms: one DB open, FTS5 queries, two small file ops.
 * Every failure path degrades to "inject nothing" — never an error.
 */
import { existsSync } from "node:fs";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import { type SearchHit, searchRecords } from "../storage/search.js";
import { appendInjectedIds, dedupFilePath, readInjectedIds } from "./dedup.js";
import type { HookEnv } from "./env.js";
import type { HookPayload } from "./payload.js";
import { recordInjection } from "./sessions.js";
import { estimateTokens } from "./tokens.js";

/** Per-turn budgets (SPEC §9, Invariant 2). Never configurable upward. */
export const PROMPT_SUBMIT_MAX_TOKENS = 2000;
export const PROMPT_SUBMIT_MAX_CHARS = 8000;
export const PROMPT_SUBMIT_TOP_K = 3;

/** Fetch extra candidates so dedup filtering still leaves a full top-3. */
const SEARCH_CANDIDATES = 12;

const HEADER = "Relevant project context (agentctx):";

export async function runUserPromptSubmit(env: HookEnv, payload: HookPayload): Promise<void> {
  const prompt = payload.prompt?.trim();
  if (prompt === undefined || prompt.length === 0 || !existsSync(env.dbPath)) {
    return;
  }
  const cwd = payload.cwd ?? env.cwd;
  const projectId = resolveProjectId(cwd);
  const dedupPath =
    payload.sessionId === null ? null : dedupFilePath(env.tmpDir, payload.sessionId);

  const db = openDatabase(env.dbPath);
  try {
    const { results } = searchRecords(db, projectId, prompt, { limit: SEARCH_CANDIDATES });
    const alreadyInjected = dedupPath === null ? new Set<string>() : readInjectedIds(dedupPath);
    const fresh = results
      .filter((hit) => !alreadyInjected.has(hit.record.id))
      .slice(0, PROMPT_SUBMIT_TOP_K);

    const { text, ids, tokens } = formatInjection(fresh);
    if (ids.length === 0) {
      return;
    }

    env.emit({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text },
    });
    if (dedupPath !== null) {
      appendInjectedIds(dedupPath, ids);
    }
    if (payload.sessionId !== null) {
      try {
        recordInjection(db, {
          sessionId: payload.sessionId,
          projectId,
          tokens,
          at: env.now().toISOString(),
        });
      } catch (error) {
        env.log(`user-prompt-submit: token accounting failed: ${describe(error)}`);
      }
    }
  } finally {
    db.close();
  }
}

export interface InjectionText {
  text: string;
  /** IDs actually injected, in rank order. */
  ids: string[];
  /** Token estimate for self-accounting. */
  tokens: number;
}

/**
 * Render ranked hits into the injected block, dropping the lowest-ranked
 * first when a budget would overflow (SPEC §9). Inferred records are marked
 * as unconfirmed so they are never presented as established fact (§3.3).
 */
export function formatInjection(
  hits: readonly SearchHit[],
  maxTokens: number = PROMPT_SUBMIT_MAX_TOKENS,
  maxChars: number = PROMPT_SUBMIT_MAX_CHARS,
): InjectionText {
  let text = HEADER;
  const ids: string[] = [];
  for (const hit of hits) {
    const marker = hit.record.confidence === "inferred" ? " (unconfirmed pattern)" : "";
    const block = `\n\n[${hit.record.type}] ${hit.record.title}${marker}\n${hit.record.body}`;
    const candidate = text + block;
    if (candidate.length > maxChars || estimateTokens(candidate) > maxTokens) {
      break;
    }
    text = candidate;
    ids.push(hit.record.id);
  }
  if (ids.length === 0) {
    return { text: "", ids: [], tokens: 0 };
  }
  return { text, ids, tokens: estimateTokens(text) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
