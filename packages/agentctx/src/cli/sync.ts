/**
 * `agentctx sync` — render a proposed CLAUDE.md diff and, on confirmation,
 * append the missing additions (ADR-013, Invariant 5: never auto-apply).
 *
 * Invariant 5 (SPEC §1): CLAUDE.md is a user-controlled file. This command
 * shows what to add and asks before writing — it never applies changes
 * silently or without confirmation.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { type DriftEntry, buildSyncReport, findClaudeMd } from "../consolidate/drift.js";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import type { CliEnv } from "./env.js";

export const SYNC_USAGE = `Usage: agentctx sync

Compares the context store's decisions and conventions against CLAUDE.md and
proposes additions. Never writes without explicit confirmation.

When the store has records not reflected in CLAUDE.md, shows a proposed diff
and asks whether to append them. Removals are surfaced for review only —
they always require manual editing (never automatically removed).`;

export async function runSync(env: CliEnv, args: string[]): Promise<number> {
  if (args.includes("--help")) {
    env.io.out(SYNC_USAGE);
    return 0;
  }

  if (!existsSync(env.dbPath)) {
    env.io.out("nothing to sync: no agentctx database (run `agentctx init` first)");
    return 0;
  }

  const claudeMdPath = findClaudeMd(env.cwd);
  if (claudeMdPath === null) {
    env.io.out(
      "no CLAUDE.md found in the project root or .claude/ — create one first, then run `agentctx sync`",
    );
    return 0;
  }

  const projectId = resolveProjectId(env.cwd);
  const db = openDatabase(env.dbPath);
  let report: ReturnType<typeof buildSyncReport>;
  try {
    report = buildSyncReport(db, projectId, env.cwd);
  } finally {
    db.close();
  }

  if (report.missing.length === 0 && report.contradicted.length === 0) {
    env.io.out("✓ CLAUDE.md appears up-to-date — no drift candidates found");
    return 0;
  }

  env.io.out(report.proposed_diff);

  if (report.missing.length === 0) {
    env.io.out(
      "\nNo additions proposed — review the superseded entries above and update CLAUDE.md manually if needed.",
    );
    return 0;
  }

  const confirmed = await env.io.confirm(
    `\nAppend ${report.missing.length} addition(s) to ${claudeMdPath}?`,
  );
  if (!confirmed) {
    env.io.err("aborted: CLAUDE.md unchanged");
    return 0;
  }

  // Append only the 'missing' additions. Removals require human judgment and
  // are shown for review only — never automatically stripped (Invariant 5).
  try {
    const existing = readFileSync(claudeMdPath, "utf8");
    const appendContent = buildAdditionsBlock(report.missing);
    writeFileSync(claudeMdPath, `${existing.trimEnd()}\n\n${appendContent}\n`, "utf8");
  } catch (err) {
    env.io.err(
      `failed to write ${claudeMdPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  env.io.out(`✓ appended ${report.missing.length} record(s) to ${claudeMdPath}`);

  return 0;
}

function buildAdditionsBlock(missing: DriftEntry[]): string {
  const lines: string[] = ["<!-- agentctx sync additions -->"];
  for (const entry of missing) {
    lines.push(`\n## ${entry.title}`);
    if (entry.body.trim().length > 0) {
      lines.push(`\n${entry.body}`);
    }
  }
  return lines.join("\n");
}
