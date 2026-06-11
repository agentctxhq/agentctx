/**
 * Per-session injection dedup file: `/tmp/agentctx-<session_id>.json`, a
 * JSON array of already-injected record IDs (SPEC §4, ADR-007).
 *
 * This is derived, disposable state (SPEC §7): a missing, corrupt, or
 * unwritable file degrades to re-injection — never to an error.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function dedupFilePath(tmpDir: string, sessionId: string): string {
  // Session ids are UUIDs in practice; sanitize anyway so a hostile or
  // malformed id can never traverse out of the temp directory.
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(tmpDir, `agentctx-${safe}.json`);
}

export function readInjectedIds(path: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function appendInjectedIds(path: string, ids: readonly string[]): void {
  try {
    const merged = readInjectedIds(path);
    for (const id of ids) {
      merged.add(id);
    }
    writeFileSync(path, JSON.stringify([...merged]), "utf8");
  } catch {
    /* worst case is re-injection next turn — never an error */
  }
}
