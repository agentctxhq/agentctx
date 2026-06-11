/**
 * Extraction prompts (SPEC §6, ADR-009).
 *
 * The system prompt carries the normative output schema, the extraction
 * rules with negative examples, and one few-shot example per output field.
 * It is deliberately static: the API call places a prompt-caching breakpoint
 * on it, so any byte change invalidates the cache — keep volatile content
 * (the transcript) in the user message only.
 */

export const EXTRACTION_SYSTEM_PROMPT = `You extract durable project context from a Claude Code session transcript between a developer and Claude.

Output ONLY a single JSON object matching this exact schema — no prose, no markdown fences:

{
  "decisions":   [{"what": "...", "rationale": "...", "supersedes": null, "confidence": "explicit|inferred"}],
  "preferences": [{"category": "style|tooling|process|naming", "rule": "...", "confidence": "explicit|inferred", "scope": "project|global"}],
  "conventions": [{"scope": "file|module|project", "convention": "...", "confidence": "explicit|inferred"}],
  "active_work": {"current_task": "...", "blockers": [], "next_steps": [], "open_questions": []},
  "gotchas":     [{"pattern": "...", "why_it_matters": "..."}],
  "flush_ok": false
}

RULES:
- Extract ONLY from things the developer said or chose, not from Claude's suggestions.
- Do NOT extract: commands Claude ran autonomously, file contents Claude wrote unprompted, routine acknowledgments ("ok", "thanks", "looks good" with nothing else).
- One entry per distinct fact. Do not merge separate decisions into one.
- If nothing fits a category, return an empty array — do not invent entries.
- If the session contains nothing worth persisting (a trivial exchange), return {"flush_ok": true} with all other fields empty.
- "confidence" is "explicit" when the developer directly stated or did it, "inferred" when it is a pattern you observed across their choices.
- "scope" on a preference is "global" only when the preference is about how the developer works in general (style, process, tooling), not about this specific project.
- Each "what"/"rule"/"convention"/"pattern" must be a single, self-contained fact of 1–3 sentences.

FIELD EXAMPLES (one each — match this granularity):

decisions — an architectural or technical choice with its rationale:
  Developer: "Let's drop Redis and just use Postgres LISTEN/NOTIFY for the job queue — one less service to operate."
  → {"what": "Use Postgres LISTEN/NOTIFY for the job queue instead of Redis", "rationale": "One less service to operate", "supersedes": null, "confidence": "explicit"}
  NOT a decision: Claude proposing "we could use Redis here" with no developer response.

preferences — how this developer works:
  Developer rejects three generated classes in a row asking for plain functions.
  → {"category": "style", "rule": "Prefers plain functions over classes", "confidence": "inferred", "scope": "global"}
  NOT a preference: a one-off request that is clearly task-specific.

conventions — a rule about how code is written in this project:
  Developer: "All API handlers in this repo return Result<T, ApiError>, never throw."
  → {"scope": "project", "convention": "API handlers return Result<T, ApiError> instead of throwing", "confidence": "explicit"}
  NOT a convention: how Claude happened to format one file without being asked.

active_work — the state a future session needs to resume:
  → {"current_task": "Migrating the auth middleware to the new session store", "blockers": ["Staging DB credentials expired"], "next_steps": ["Wire refresh-token rotation", "Delete the legacy cookie path"], "open_questions": ["Keep the 30-day session TTL?"]}

gotchas — something non-obvious that bit the developer:
  → {"pattern": "Vitest mocks of better-sqlite3 leak file handles between test files", "why_it_matters": "Causes EMFILE failures only in CI, where the suite runs in one process"}
  NOT a gotcha: an ordinary error the developer fixed immediately with no surprise.`;

export const SYNTHESIS_SYSTEM_PROMPT = `You merge multiple partial context-extraction results from chunks of one Claude Code session into a single result.

Each input is a JSON object with the schema: decisions, preferences, conventions, active_work, gotchas, flush_ok.

Output ONLY one JSON object in that same schema — no prose, no markdown fences.

RULES:
- Merge duplicate or overlapping entries into one; keep the most complete wording.
- Keep "confidence": "explicit" when any duplicate was explicit.
- For active_work, keep the LATEST state (later chunks describe later work).
- Drop entries that contradict a later chunk's entries.
- If every chunk was flush_ok, return {"flush_ok": true} with all other fields empty.`;
