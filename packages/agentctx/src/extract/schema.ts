/**
 * Extraction output schema (SPEC §6) — parsing and entry-level validation.
 *
 * Validation is per-entry, not all-or-nothing: a malformed entry is dropped
 * (SPEC §6 ingest rules) while the rest of the result survives. Only an
 * unparseable or non-object response fails the whole extraction.
 */

export interface DecisionEntry {
  what: string;
  rationale: string | null;
  supersedes: string | null;
  confidence: "explicit" | "inferred";
}

export const PREFERENCE_CATEGORIES = ["style", "tooling", "process", "naming"] as const;

export interface PreferenceEntry {
  category: (typeof PREFERENCE_CATEGORIES)[number];
  rule: string;
  confidence: "explicit" | "inferred";
  scope: "project" | "global";
}

export const CONVENTION_SCOPES = ["file", "module", "project"] as const;

export interface ConventionEntry {
  scope: (typeof CONVENTION_SCOPES)[number];
  convention: string;
  confidence: "explicit" | "inferred";
}

export interface ActiveWork {
  currentTask: string;
  blockers: string[];
  nextSteps: string[];
  openQuestions: string[];
}

export interface GotchaEntry {
  pattern: string;
  whyItMatters: string;
}

export interface ExtractionResult {
  decisions: DecisionEntry[];
  preferences: PreferenceEntry[];
  conventions: ConventionEntry[];
  activeWork: ActiveWork | null;
  gotchas: GotchaEntry[];
  flushOk: boolean;
  /** Entries dropped by validation, for the extraction log. */
  droppedEntries: number;
}

/**
 * Parse a model response into a validated ExtractionResult. Returns null
 * when the response is not a JSON object at all (a hard extraction failure,
 * logged and skipped — SPEC §6).
 */
export function parseExtraction(raw: string): ExtractionResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  let dropped = 0;
  const drop = () => {
    dropped++;
    return null;
  };

  const decisions = entryArray(obj.decisions, (e) => parseDecision(e) ?? drop());
  const preferences = entryArray(obj.preferences, (e) => parsePreference(e) ?? drop());
  const conventions = entryArray(obj.conventions, (e) => parseConvention(e) ?? drop());
  const gotchas = entryArray(obj.gotchas, (e) => parseGotcha(e) ?? drop());

  return {
    decisions,
    preferences,
    conventions,
    activeWork: parseActiveWork(obj.active_work),
    gotchas,
    flushOk: obj.flush_ok === true,
    droppedEntries: dropped,
  };
}

function stripFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1]?.trim() ?? trimmed;
}

function entryArray<T>(value: unknown, parse: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(parse).filter((entry): entry is T => entry !== null);
}

function parseDecision(entry: unknown): DecisionEntry | null {
  const e = asObject(entry);
  if (e === null) return null;
  const what = nonEmptyString(e.what);
  const confidence = parseConfidence(e.confidence);
  if (what === null || confidence === null) return null;
  return {
    what,
    rationale: nonEmptyString(e.rationale),
    supersedes: nonEmptyString(e.supersedes),
    confidence,
  };
}

function parsePreference(entry: unknown): PreferenceEntry | null {
  const e = asObject(entry);
  if (e === null) return null;
  const rule = nonEmptyString(e.rule);
  const confidence = parseConfidence(e.confidence);
  if (rule === null || confidence === null) return null;
  if (!isOneOf(e.category, PREFERENCE_CATEGORIES)) return null;
  return {
    category: e.category,
    rule,
    confidence,
    scope: e.scope === "global" ? "global" : "project",
  };
}

function parseConvention(entry: unknown): ConventionEntry | null {
  const e = asObject(entry);
  if (e === null) return null;
  const convention = nonEmptyString(e.convention);
  const confidence = parseConfidence(e.confidence);
  if (convention === null || confidence === null) return null;
  if (!isOneOf(e.scope, CONVENTION_SCOPES)) return null;
  return { scope: e.scope, convention, confidence };
}

function parseGotcha(entry: unknown): GotchaEntry | null {
  const e = asObject(entry);
  if (e === null) return null;
  const pattern = nonEmptyString(e.pattern);
  const why = nonEmptyString(e.why_it_matters);
  if (pattern === null || why === null) return null;
  return { pattern, whyItMatters: why };
}

function parseActiveWork(value: unknown): ActiveWork | null {
  const e = asObject(value);
  if (e === null) return null;
  const work: ActiveWork = {
    currentTask: nonEmptyString(e.current_task) ?? "",
    blockers: stringArray(e.blockers),
    nextSteps: stringArray(e.next_steps),
    openQuestions: stringArray(e.open_questions),
  };
  const empty =
    work.currentTask === "" &&
    work.blockers.length === 0 &&
    work.nextSteps.length === 0 &&
    work.openQuestions.length === 0;
  return empty ? null : work;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseConfidence(value: unknown): "explicit" | "inferred" | null {
  return value === "explicit" || value === "inferred" ? value : null;
}

function isOneOf<T extends string>(value: unknown, options: readonly T[]): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}
