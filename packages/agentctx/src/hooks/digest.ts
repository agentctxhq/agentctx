/**
 * SessionStart digest file: format, location, and budgeted composition
 * (SPEC §4, ADR-007).
 *
 * The digest is derived data (SPEC §7), pre-computed at SessionEnd by
 * `agentctx consolidate` and only *read* at SessionStart —
 * never computed inline. This module owns the contract both sides share.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../claude/json-file.js";
import { estimateTokens, truncateToTokens } from "./tokens.js";

/** SessionStart hard cap (SPEC §9, Invariant 2). Never configurable upward. */
export const SESSION_START_MAX_TOKENS = 1500;

/**
 * Digest sections in priority order. Truncation drops from the bottom of
 * this list (SPEC §4): profile ~200t, decisions ~500t, handover ~400t,
 * reinforced global preferences ~200t, MCP index hint ~100t. The per-section
 * targets are honored at digest *build* time; composition here only enforces
 * the total.
 */
export const DIGEST_SECTION_ORDER = [
  "profile",
  "decisions",
  "handover",
  "globalPreferences",
  "mcpHint",
  "driftHint",
] as const;

export type DigestSection = (typeof DIGEST_SECTION_ORDER)[number];

export interface DigestFile {
  version: number;
  projectId: string;
  generatedAt: string;
  /** Pre-formatted section bodies, ready to inject verbatim. */
  sections: Partial<Record<DigestSection, string>>;
}

/** Don't bother emitting a partial section smaller than this. */
const MIN_PARTIAL_SECTION_TOKENS = 40;

export function digestFilePath(agentctxHome: string, projectId: string): string {
  return join(agentctxHome, "digests", `${projectId}.json`);
}

/** Read and validate a digest file. Missing or malformed → null, never an error. */
export function readDigestFile(path: string): DigestFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isJsonObject(parsed) || !isJsonObject(parsed.sections)) {
    return null;
  }
  const sections: Partial<Record<DigestSection, string>> = {};
  for (const name of DIGEST_SECTION_ORDER) {
    const content = parsed.sections[name];
    if (typeof content === "string" && content.trim().length > 0) {
      sections[name] = content;
    }
  }
  return {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
    generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : "",
    sections,
  };
}

/**
 * Assemble sections in priority order under a hard token cap, truncating
 * from the bottom: a section that does not fit is cut to the remaining
 * budget (when meaningful) or dropped along with everything after it.
 */
export function composeDigest(
  sections: Partial<Record<DigestSection, string>>,
  maxTokens: number = SESSION_START_MAX_TOKENS,
): string {
  const parts: string[] = [];
  let remaining = maxTokens;
  for (const name of DIGEST_SECTION_ORDER) {
    const content = sections[name]?.trim();
    if (content === undefined || content.length === 0) {
      continue;
    }
    const budget = parts.length === 0 ? remaining : remaining - estimateTokens("\n\n");
    const cost = estimateTokens(content);
    if (cost <= budget) {
      parts.push(content);
      remaining = budget - cost;
      continue;
    }
    if (budget >= MIN_PARTIAL_SECTION_TOKENS) {
      parts.push(truncateToTokens(content, budget));
    }
    break;
  }
  return parts.join("\n\n");
}
