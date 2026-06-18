/**
 * PostToolUse hook (SPEC §4, ADR-012 Path B): deterministic observation
 * capture only. MUST NOT call an LLM or load a model.
 *
 * Captured signals:
 * - file-writing tools → `nodes` entity (kind `file`)
 * - Bash git branch operations → `nodes` entity (kind `branch`)
 * - Bash test-runner failures and hard error patterns → `bugfix` stub
 *   records (title + minimal body; LLM extraction enriches them later),
 *   deduplicated by title, entity-linked to a file path when one is
 *   recognizable in the error output
 *
 * Passing test runs are deliberately not recorded: a record per green test
 * run is noise that decay would have to clean up.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import { insertRecord } from "../storage/records.js";
import { BODY_MAX_CHARS, TITLE_MAX_CHARS } from "../storage/types.js";
import { linkRecordToEntity, upsertNode } from "./entities.js";
import type { HookEnv } from "./env.js";
import type { HookPayload } from "./payload.js";

const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

const TEST_COMMAND_RE =
  /\b(?:vitest|jest|pytest|mocha|playwright\s+test|go\s+test|cargo\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test)\b/;

/** Failure markers for test output (broad — test runners are explicit about failure). */
const TEST_FAILURE_RE = /\b(?:FAIL(?:ED)?|failing|AssertionError)\b|✗|✘|\d+\s+failed/;

/** Hard error markers for non-test commands (narrow — avoid stub noise). */
const HARD_ERROR_RE =
  /(?:^|\s)(?:error(?:\[\w+\])?:|err!|fatal:|panic:)|Traceback \(most recent|Unhandled(?:Promise)?Rejection|\b\w*(?:Error|Exception):/i;

const SOURCE_FILE_RE =
  /(?:^|[\s'"`(])((?:\.{0,2}\/)?[\w@][\w@/.-]*\.(?:[cm]?[jt]sx?|py|go|rs|java|rb|cs|php|swift|kt|c|cc|cpp|h|hpp))(?=[\s:'"`)\],]|$)/m;

export async function runPostToolUse(env: HookEnv, payload: HookPayload): Promise<void> {
  if (payload.toolName === null || !existsSync(env.dbPath)) {
    return;
  }
  const cwd = payload.cwd ?? env.cwd;
  const projectId = resolveProjectId(cwd);

  const db = openDatabase(env.dbPath);
  try {
    if (FILE_WRITE_TOOLS.has(payload.toolName)) {
      captureFileWrite(db, projectId, cwd, payload);
    } else if (payload.toolName === "Bash") {
      captureBash(db, projectId, cwd, payload);
    }
  } finally {
    db.close();
  }
}

function captureFileWrite(
  db: Database,
  projectId: string,
  cwd: string,
  payload: HookPayload,
): void {
  const raw = payload.toolInput.file_path ?? payload.toolInput.notebook_path;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return;
  }
  upsertNode(db, projectId, "file", resolve(cwd, raw.trim()));
}

function captureBash(db: Database, projectId: string, cwd: string, payload: HookPayload): void {
  const command = payload.toolInput.command;
  if (typeof command !== "string" || command.trim().length === 0) {
    return;
  }
  const output = responseText(payload.toolResponse);

  const branch = extractGitBranch(command);
  if (branch !== null) {
    upsertNode(db, projectId, "branch", branch);
    return;
  }

  const isTest = TEST_COMMAND_RE.test(command);
  const errorLine = isTest
    ? firstMatchingLine(output, TEST_FAILURE_RE)
    : firstMatchingLine(output, HARD_ERROR_RE);
  if (errorLine === null) {
    return;
  }
  insertBugfixStub(db, projectId, cwd, payload.sessionId, command, errorLine, output, isTest);
}

function extractGitBranch(command: string): string | null {
  const tokens = command.trim().split(/\s+/);
  if (tokens[0] !== "git" || (tokens[1] !== "checkout" && tokens[1] !== "switch")) {
    return null;
  }

  let index = 2;
  if (
    (tokens[1] === "checkout" && tokens[index] === "-b") ||
    (tokens[1] === "switch" && tokens[index] === "-c")
  ) {
    index += 1;
  }

  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) {
      continue;
    }
    if (token === "--") {
      return null;
    }
    if (!token.startsWith("-")) {
      return token;
    }
  }

  return null;
}

/** ADR-012: error-pattern → `bugfix` candidate stub; LLM extraction fills the rationale. */
function insertBugfixStub(
  db: Database,
  projectId: string,
  cwd: string,
  sessionId: string | null,
  command: string,
  errorLine: string,
  output: string,
  isTest: boolean,
): void {
  const prefix = isTest ? "Test failure" : "Error observed";
  const title = clamp(`${prefix}: ${firstLine(command)}`, TITLE_MAX_CHARS);

  // One stub per distinct title per project: repeated runs of the same
  // failing command must not pile up records.
  const existing = db
    .prepare(
      `SELECT 1 FROM records
       WHERE project_id = ? AND type = 'bugfix' AND title = ? AND superseded_at IS NULL`,
    )
    .get(projectId, title);
  if (existing !== undefined) {
    return;
  }

  const body = clamp(
    `Command: ${firstLine(command)}\nObserved: ${errorLine.trim()}`,
    BODY_MAX_CHARS,
  );
  const record: Parameters<typeof insertRecord>[1] = {
    projectId,
    type: "bugfix",
    title,
    body,
    source: "hook_observation",
    confidence: "inferred",
  };
  if (sessionId !== null) {
    record.sessionId = sessionId;
  }
  const inserted = insertRecord(db, record);

  const file = extractSourceFile(errorLine) ?? extractSourceFile(output);
  if (file !== undefined) {
    linkRecordToEntity(db, inserted.id, upsertNode(db, projectId, "file", resolve(cwd, file)));
  }
}

/** Flatten a tool response into searchable text without assuming its shape. */
export function responseText(response: unknown): string {
  if (typeof response === "string") {
    return response;
  }
  if (typeof response !== "object" || response === null) {
    return "";
  }
  const parts: string[] = [];
  for (const key of ["stdout", "stderr", "output", "error"] as const) {
    const value = (response as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
      parts.push(value);
    }
  }
  return parts.join("\n");
}

function firstMatchingLine(text: string, pattern: RegExp): string | null {
  for (const line of text.split("\n")) {
    if (pattern.test(line)) {
      return line;
    }
  }
  return null;
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return (newline === -1 ? text : text.slice(0, newline)).trim();
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function extractSourceFile(text: string): string | undefined {
  return SOURCE_FILE_RE.exec(text)?.[1];
}
