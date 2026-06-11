/**
 * Hook payload parsing. Claude Code sends one JSON object on stdin per hook
 * invocation; field availability varies by event. Parsing is lenient — a
 * missing or wrongly-typed field becomes null/empty, never an error.
 */
import { isJsonObject } from "../claude/json-file.js";

export interface HookPayload {
  sessionId: string | null;
  transcriptPath: string | null;
  cwd: string | null;
  /** SessionStart: "startup" | "resume" | "clear" | "compact". */
  source: string | null;
  /** UserPromptSubmit. */
  prompt: string | null;
  /** PostToolUse. */
  toolName: string | null;
  toolInput: Record<string, unknown>;
  toolResponse: unknown;
}

/** Parse a raw stdin body. Returns null when there is no usable payload. */
export function parseHookPayload(raw: string): HookPayload | null {
  if (raw.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isJsonObject(parsed)) {
    return null;
  }
  return {
    sessionId: stringOrNull(parsed.session_id),
    transcriptPath: stringOrNull(parsed.transcript_path),
    cwd: stringOrNull(parsed.cwd),
    source: stringOrNull(parsed.source),
    prompt: stringOrNull(parsed.prompt),
    toolName: stringOrNull(parsed.tool_name),
    toolInput: isJsonObject(parsed.tool_input) ? parsed.tool_input : {},
    toolResponse: parsed.tool_response,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
