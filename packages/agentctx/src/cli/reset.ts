/**
 * `agentctx reset` — hard-delete the current project's context.
 *
 * The one deliberately destructive data command: requires confirmation
 * (or `--force`), touches only the current project's namespace — global
 * records and other projects survive.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { openDatabase } from "../storage/db.js";
import { countProjectRecords, deleteProjectData } from "../storage/maintenance.js";
import { resolveProjectId } from "../storage/namespace.js";
import type { CliEnv } from "./env.js";

export const RESET_USAGE = `Usage: agentctx reset [options]

Deletes all context records for the current project (determined from cwd).

Options:
  --force   skip the confirmation prompt (required without a TTY)`;

export async function runReset(env: CliEnv, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      force: { type: "boolean", default: false },
    },
  });

  if (!existsSync(env.dbPath)) {
    env.io.out("nothing to reset: no agentctx database (run `agentctx init` first)");
    return 0;
  }

  const projectId = resolveProjectId(env.cwd);
  const db = openDatabase(env.dbPath);
  try {
    const count = countProjectRecords(db, projectId);
    if (count === 0) {
      env.io.out("nothing to reset: this project has no context records");
      return 0;
    }

    const confirmed =
      values.force ||
      (await env.io.confirm(
        `Delete all ${count} context record(s) for this project? This cannot be undone.`,
      ));
    if (!confirmed) {
      env.io.err("aborted: project context kept (pass --force to skip the prompt)");
      return 1;
    }

    const result = deleteProjectData(db, projectId);
    env.io.out(
      `✓ deleted ${result.records} record(s), ${result.nodes} node(s), ` +
        `${result.edges} edge(s), ${result.sessions} session(s) for project ${projectId.slice(0, 12)}…`,
    );
  } finally {
    db.close();
  }
  return 0;
}
