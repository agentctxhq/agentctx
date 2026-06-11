/**
 * Claude Code transcript parsing and the extraction input policy (SPEC §6,
 * ADR-009).
 *
 * A transcript is JSONL: one entry per line, `type: "user" | "assistant"`
 * with a `message.content` that is either a string or an array of content
 * blocks. Only conversational text matters for extraction — tool results
 * (which also arrive as `user` entries), meta entries, and tool_use blocks
 * are noise the model should never see.
 *
 * Input policy by size (token-estimated, SPEC §6):
 *   ≤ 15K tokens  → full transcript, one call
 *   15–50K tokens → first 3K + last 17K tokens
 *   > 50K tokens  → Map-Reduce: 10K-token chunks + one synthesis call
 */
import { CHARS_PER_TOKEN, estimateTokens } from "../hooks/tokens.js";

export interface TranscriptTurn {
  role: "developer" | "assistant";
  text: string;
}

/** SPEC §6 size thresholds, in estimated tokens. */
export const FULL_TRANSCRIPT_MAX_TOKENS = 15_000;
export const TRUNCATED_TRANSCRIPT_MAX_TOKENS = 50_000;
export const TRUNCATED_HEAD_TOKENS = 3_000;
export const TRUNCATED_TAIL_TOKENS = 17_000;
export const MAP_REDUCE_CHUNK_TOKENS = 10_000;

/** Parse a Claude Code transcript (JSONL) into conversational turns. */
export function parseTranscript(content: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // partial or corrupt lines are skipped, never fatal
    }
    const turn = entryToTurn(entry);
    if (turn !== null) {
      turns.push(turn);
    }
  }
  return turns;
}

/** Render turns as the plain-text conversation the extraction model reads. */
export function renderTurns(turns: TranscriptTurn[]): string {
  return turns
    .map((turn) => `${turn.role === "developer" ? "Developer" : "Assistant"}: ${turn.text}`)
    .join("\n\n");
}

export type ExtractionInput =
  | { mode: "full" | "truncated"; text: string }
  | { mode: "map-reduce"; chunks: string[] };

/** Apply the SPEC §6 input policy to a rendered transcript. */
export function selectExtractionInput(rendered: string): ExtractionInput {
  const tokens = estimateTokens(rendered);
  if (tokens <= FULL_TRANSCRIPT_MAX_TOKENS) {
    return { mode: "full", text: rendered };
  }
  if (tokens <= TRUNCATED_TRANSCRIPT_MAX_TOKENS) {
    const headChars = TRUNCATED_HEAD_TOKENS * CHARS_PER_TOKEN;
    const tailChars = TRUNCATED_TAIL_TOKENS * CHARS_PER_TOKEN;
    const head = rendered.slice(0, headChars);
    const tail = rendered.slice(-tailChars);
    return {
      mode: "truncated",
      text: `${head}\n\n[… transcript truncated …]\n\n${tail}`,
    };
  }
  const chunkChars = MAP_REDUCE_CHUNK_TOKENS * CHARS_PER_TOKEN;
  const chunks: string[] = [];
  for (let offset = 0; offset < rendered.length; offset += chunkChars) {
    chunks.push(rendered.slice(offset, offset + chunkChars));
  }
  return { mode: "map-reduce", chunks };
}

function entryToTurn(entry: unknown): TranscriptTurn | null {
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const e = entry as Record<string, unknown>;
  if (e.isMeta === true || (e.type !== "user" && e.type !== "assistant")) {
    return null;
  }
  const message = e.message;
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const content = (message as Record<string, unknown>).content;
  const text = contentText(content);
  if (text === null) {
    return null;
  }
  return { role: e.type === "user" ? "developer" : "assistant", text };
}

/** Extract real text from a content value; tool results/uses yield null. */
function contentText(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
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
