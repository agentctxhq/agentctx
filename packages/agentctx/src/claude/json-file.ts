/**
 * Surgical JSON file editing (ADR-016, Invariant 5).
 *
 * Claude Code settings files belong to the user. We parse, modify only our
 * own keys, and write back — and if a file does not parse as a JSON object,
 * we refuse to touch it rather than risk clobbering user configuration.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SettingsErrorCode = "parse_failed" | "unexpected_shape";

/** A user-owned settings file is missing, malformed, or shaped unexpectedly. */
export class SettingsError extends Error {
  readonly code: SettingsErrorCode;
  readonly path: string;

  constructor(code: SettingsErrorCode, path: string, message: string) {
    super(message);
    this.name = "SettingsError";
    this.code = code;
    this.path = path;
  }
}

export type JsonObject = Record<string, unknown>;

/** Outcome of a surgical edit: whether the file was actually rewritten. */
export interface SurgeryResult {
  changed: boolean;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a JSON object from `path`. Returns `null` when the file does not
 * exist; throws SettingsError when it exists but is not a parseable object.
 */
export function readJsonObject(path: string): JsonObject | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  if (raw.trim().length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SettingsError(
      "parse_failed",
      path,
      `${path} is not valid JSON (${(error as Error).message}) — fix it manually, agentctx will not overwrite it`,
    );
  }
  if (!isJsonObject(parsed)) {
    throw new SettingsError(
      "unexpected_shape",
      path,
      `${path} is not a JSON object — agentctx will not modify it`,
    );
  }
  return parsed;
}

/** Write a JSON object atomically (tmp file + rename), creating parent dirs. */
export function writeJsonObject(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.agentctx-tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    renameSync(tmpPath, path);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore cleanup error */
    }
    throw error;
  }
}
