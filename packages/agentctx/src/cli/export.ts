/**
 * `agentctx export` — render the context store as organized Markdown.
 *
 * Inspectability is a product feature (ADR-004): Markdown is a first-class
 * *export*, never the source of truth — the database remains canonical and
 * this output is derived data (SPEC §7), regenerable at any time. Active
 * records only (Invariant 3), current project plus global preferences.
 */
import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import { listRecords } from "../storage/records.js";
import { type ContextRecord, GLOBAL_PROJECT_ID, type RecordType } from "../storage/types.js";
import type { CliEnv } from "./env.js";

export const EXPORT_USAGE = `Usage: agentctx export [options]

Renders the current project's active context records (plus global developer
preferences) as Markdown on stdout.

Options:
  --out <file>   write to a file instead of stdout`;

/** Section order: stable orientation first, working state last. */
const SECTIONS: ReadonlyArray<{ type: RecordType; heading: string }> = [
  { type: "profile", heading: "Project profile" },
  { type: "decision", heading: "Decisions" },
  { type: "convention", heading: "Conventions" },
  { type: "preference", heading: "Preferences (project)" },
  { type: "discovery", heading: "Discoveries" },
  { type: "bugfix", heading: "Bugfixes" },
  { type: "handover", heading: "Last handover" },
];

const EXPORT_RECORD_LIMIT = 10_000;

export async function runExport(env: CliEnv, args: string[]): Promise<number> {
  if (args.includes("--help")) {
    env.io.out(EXPORT_USAGE);
    return 0;
  }
  const { values } = parseArgs({
    args,
    options: {
      out: { type: "string" },
    },
  });

  if (!existsSync(env.dbPath)) {
    env.io.err("agentctx is not initialized — run `agentctx init` first");
    return 1;
  }

  const projectId = resolveProjectId(env.cwd);
  const db = openDatabase(env.dbPath);
  let markdown: string;
  let count: number;
  try {
    const visible = listRecords(db, projectId, { limit: EXPORT_RECORD_LIMIT });
    const project = visible.filter((r) => r.projectId === projectId);
    // Everything else listRecords returned is global-namespace (SPEC §3.4) —
    // preferences today, but any type can land there via ctx_record's global
    // scope, and an export that silently drops records defeats ADR-004.
    const global = visible.filter((r) => r.projectId === GLOBAL_PROJECT_ID);
    count = project.length + global.length;
    markdown = renderExport(projectId, project, global, new Date());
  } finally {
    db.close();
  }

  if (values.out !== undefined) {
    writeFileSync(values.out, markdown, "utf8");
    env.io.out(`✓ exported ${count} record(s) to ${values.out}`);
  } else {
    env.io.out(markdown);
  }
  return 0;
}

export function renderExport(
  projectId: string,
  project: ContextRecord[],
  global: ContextRecord[],
  now: Date,
): string {
  const lines: string[] = [
    "# agentctx context export",
    "",
    `- Project: \`${projectId}\``,
    `- Exported: ${now.toISOString()}`,
    `- ${project.length + global.length} active record(s). Derived from the agentctx database, which remains the source of truth.`,
  ];

  for (const section of SECTIONS) {
    const records = project.filter((r) => r.type === section.type);
    if (records.length === 0) {
      continue;
    }
    lines.push("", `## ${section.heading}`);
    for (const record of byNewest(records)) {
      lines.push(...renderRecord(record));
    }
  }

  const globalPreferences = global.filter((r) => r.type === "preference");
  if (globalPreferences.length > 0) {
    lines.push("", "## Global developer preferences");
    for (const record of byNewest(globalPreferences)) {
      lines.push(...renderRecord(record));
    }
  }

  const globalOther = global.filter((r) => r.type !== "preference");
  if (globalOther.length > 0) {
    lines.push("", "## Other global records");
    for (const record of byNewest(globalOther)) {
      lines.push(...renderRecord(record));
    }
  }

  return `${lines.join("\n")}\n`;
}

function renderRecord(r: ContextRecord): string[] {
  return [
    "",
    `### ${r.title}`,
    "",
    `\`${r.id}\` · ${r.confidence} · ${r.source} · recorded ${r.recordedAt}${r.pinned ? " · pinned" : ""}`,
    "",
    r.body,
  ];
}

function byNewest(records: ContextRecord[]): ContextRecord[] {
  return [...records].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
}
