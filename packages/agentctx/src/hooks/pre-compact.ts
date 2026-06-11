/**
 * PreCompact hook (SPEC §4): snapshot the current handover candidate before
 * compaction destroys the working state it would be extracted from.
 *
 * Deterministic and minimal: capture the last user prompt from the
 * transcript tail into a keyed `handover` record (one current per project —
 * inserting supersedes the previous one, SPEC §3.5). When the transcript
 * yields nothing, no record is written: an empty stub would only destroy
 * the previous, richer handover.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import { insertRecord } from "../storage/records.js";
import type { HookEnv } from "./env.js";
import type { HookPayload } from "./payload.js";

/** How much of the transcript tail to scan for the last user prompt. */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;
/** Keep the record atomic (SPEC §3.1: body ≤ 2,000 chars). */
const PROMPT_EXCERPT_MAX_CHARS = 1500;

export async function runPreCompact(env: HookEnv, payload: HookPayload): Promise<void> {
  if (payload.transcriptPath === null || !existsSync(env.dbPath)) {
    return;
  }
  const lastPrompt = lastUserPrompt(payload.transcriptPath);
  if (lastPrompt === null) {
    return;
  }

  const projectId = resolveProjectId(payload.cwd ?? env.cwd);
  const excerpt =
    lastPrompt.length > PROMPT_EXCERPT_MAX_CHARS
      ? `${lastPrompt.slice(0, PROMPT_EXCERPT_MAX_CHARS)}…`
      : lastPrompt;

  const db = openDatabase(env.dbPath);
  try {
    const record: Parameters<typeof insertRecord>[1] = {
      projectId,
      type: "handover",
      title: "Handover: pre-compact snapshot",
      body:
        `Session context was compacted at ${env.now().toISOString()} while work was in progress. ` +
        `Last user prompt before compaction:\n${excerpt}`,
      source: "hook_observation",
      confidence: "inferred",
    };
    if (payload.sessionId !== null) {
      record.sessionId = payload.sessionId;
    }
    insertRecord(db, record);
  } finally {
    db.close();
  }
}

/**
 * Find the most recent user prompt in a Claude Code transcript (JSONL).
 * Reads only the tail — transcripts at compaction time are large by
 * definition. Returns null when nothing readable/usable is there.
 */
export function lastUserPrompt(transcriptPath: string): string | null {
  let tail: string;
  try {
    tail = readTail(transcriptPath, TRANSCRIPT_TAIL_BYTES);
  } catch {
    return null;
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.trim().length === 0) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the first tail line is usually a partial record
    }
    const text = userPromptText(entry);
    if (text !== null) {
      return text;
    }
  }
  return null;
}

function userPromptText(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const e = entry as Record<string, unknown>;
  if (e.type !== "user" || e.isMeta === true) {
    return null;
  }
  const message = e.message;
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const content = (message as Record<string, unknown>).content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? content.trim() : null;
  }
  if (Array.isArray(content)) {
    // Tool results also arrive as `user` entries; only real text counts.
    const texts = content
      .filter(
        (item): item is { type: string; text: string } =>
          typeof item === "object" &&
          item !== null &&
          (item as Record<string, unknown>).type === "text" &&
          typeof (item as Record<string, unknown>).text === "string",
      )
      .map((item) => item.text.trim())
      .filter((t) => t.length > 0);
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

function readTail(path: string, maxBytes: number): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
