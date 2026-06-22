/**
 * `agentctx profile` — manage the global developer profile (SPEC §3.4).
 *
 * Global preferences live in the reserved `_global` namespace; this command
 * is the correction surface SPEC §7 promises for inferred records: `show`
 * lists them, `edit` supersedes one with an explicit version (never edits in
 * place — bi-temporal history is ground truth), `clear` hard-deletes a wrong
 * one. Mutations refresh the derived export at `~/.agentctx/profile/`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../storage/db.js";
import { getRecord, listRecords, supersedeRecord } from "../storage/records.js";
import { type ContextRecord, GLOBAL_PROJECT_ID } from "../storage/types.js";
import type { CliEnv } from "./env.js";

export const PROFILE_USAGE = `Usage: agentctx profile <command>

Commands:
  show                                  list global developer preferences
  edit <id> [--title <t>] [--body <b>]  correct a preference (supersedes it)
  clear <id> [--force]                  delete a preference outright`;

export async function runProfile(env: CliEnv, args: string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
      env.io.err(PROFILE_USAGE);
      return 1;
    case "--help":
    case "help":
      env.io.out(PROFILE_USAGE);
      return 0;
    case "show":
      return profileShow(env);
    case "edit":
      return profileEdit(env, rest);
    case "clear":
      return profileClear(env, rest);
    default:
      env.io.err(`agentctx profile: unknown command "${command}"`);
      env.io.err(PROFILE_USAGE);
      return 1;
  }
}

function requireDb(env: CliEnv): Database | null {
  if (!existsSync(env.dbPath)) {
    env.io.err("agentctx is not initialized — run `agentctx init` first");
    return null;
  }
  return openDatabase(env.dbPath);
}

async function profileShow(env: CliEnv): Promise<number> {
  const db = requireDb(env);
  if (db === null) return 1;
  try {
    const prefs = globalPreferences(db);
    if (prefs.length === 0) {
      env.io.out(
        "no global developer preferences yet — they accumulate from session extraction over time",
      );
      return 0;
    }
    env.io.out(`Global developer preferences (${prefs.length}):`);
    env.io.out("");
    for (const record of prefs) {
      env.io.out(`${record.id}  [${record.confidence}]  ${record.title}`);
      for (const line of record.body.split("\n")) {
        env.io.out(`    ${line}`);
      }
      env.io.out("");
    }
    env.io.out(
      "correct with `agentctx profile edit <id>`, remove with `agentctx profile clear <id>`",
    );
  } finally {
    db.close();
  }
  return 0;
}

async function profileEdit(env: CliEnv, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      title: { type: "string" },
      body: { type: "string" },
    },
  });
  const id = positionals[0];
  if (id === undefined || positionals.length !== 1) {
    env.io.err("agentctx profile edit: exactly one record id is required");
    return 1;
  }
  if (values.title === undefined && values.body === undefined) {
    env.io.err("agentctx profile edit: provide --title and/or --body with the corrected text");
    return 1;
  }

  const db = requireDb(env);
  if (db === null) return 1;
  try {
    const record = requireGlobalPreference(env, db, id, "edit");
    if (record === null) return 1;
    if (record.supersededAt !== null) {
      env.io.err(
        `agentctx profile edit: ${id} is already superseded${
          record.supersededBy === null ? "" : ` — edit the current version ${record.supersededBy}`
        }`,
      );
      return 1;
    }
    const { replacement } = supersedeRecord(db, id, {
      title: values.title ?? record.title,
      body: values.body ?? record.body,
      source: "cli",
      confidence: "explicit",
    });
    writeProfileExport(env.agentctxHome, globalPreferences(db));
    env.io.out(`✓ preference updated: ${id} superseded by ${replacement.id} (explicit)`);
  } finally {
    db.close();
  }
  return 0;
}

async function profileClear(env: CliEnv, args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      force: { type: "boolean", default: false },
    },
  });
  const id = positionals[0];
  if (id === undefined || positionals.length !== 1) {
    env.io.err("agentctx profile clear: exactly one record id is required");
    return 1;
  }

  const db = requireDb(env);
  if (db === null) return 1;
  try {
    const record = requireGlobalPreference(env, db, id, "clear");
    if (record === null) return 1;
    // Deleting an already-superseded version would leave the current head in
    // place — the user would think the preference is gone when it isn't.
    if (record.supersededAt !== null) {
      env.io.err(
        `agentctx profile clear: ${id} is already superseded${
          record.supersededBy === null ? "" : ` — the current version is ${record.supersededBy}`
        }; use the current id to remove the preference`,
      );
      return 1;
    }

    const confirmed =
      values.force ||
      (await env.io.confirm(`Delete preference "${record.title}"? This cannot be undone.`));
    if (!confirmed) {
      env.io.err("aborted: preference kept (pass --force to skip the prompt)");
      return 1;
    }

    deleteRecord(db, id);
    writeProfileExport(env.agentctxHome, globalPreferences(db));
    env.io.out(`✓ preference deleted: ${record.title}`);
  } finally {
    db.close();
  }
  return 0;
}

function requireGlobalPreference(
  env: CliEnv,
  db: Database,
  id: string,
  verb: string,
): ContextRecord | null {
  const record = getRecord(db, id, { includeSuperseded: true });
  if (record === null) {
    env.io.err(`agentctx profile ${verb}: no record with id ${id}`);
    return null;
  }
  if (record.projectId !== GLOBAL_PROJECT_ID || record.type !== "preference") {
    env.io.err(
      `agentctx profile ${verb}: ${id} is not a global preference (it is a ${record.scope} ${record.type})`,
    );
    return null;
  }
  return record;
}

function globalPreferences(db: Database): ContextRecord[] {
  return listRecords(db, GLOBAL_PROJECT_ID, { type: "preference" });
}

/**
 * Hard delete (SPEC §3.3: a wrong record is superseded or deleted). FTS rows
 * follow via triggers; inbound references are detached first — records this
 * one superseded keep their `superseded_at` (they stay historical), only the
 * dangling pointer is cleared.
 */
function deleteRecord(db: Database, id: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM record_entities WHERE record_id = ?").run(id);
    db.prepare("UPDATE records SET superseded_by = NULL WHERE superseded_by = ?").run(id);
    db.prepare("DELETE FROM records WHERE id = ?").run(id);
  })();
}

/**
 * Derived export of the global profile at `~/.agentctx/profile/` (SPEC §2.4,
 * §3.4) — rebuildable from the store, refreshed on every mutation.
 */
export function writeProfileExport(agentctxHome: string, prefs: ContextRecord[]): void {
  const dir = join(agentctxHome, "profile");
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [
    "# Global developer preferences",
    "",
    "Derived export — regenerated by `agentctx profile`; the database is the source of truth.",
  ];
  for (const record of prefs) {
    lines.push(
      "",
      `## ${record.title}`,
      "",
      `\`${record.id}\` · ${record.confidence}`,
      "",
      record.body,
    );
  }
  writeFileSync(join(dir, "preferences.md"), `${lines.join("\n")}\n`, "utf8");
}
