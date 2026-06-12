/**
 * `agentctx show <id>` — pretty-print a full record.
 *
 * Inspectability is a product feature (ADR-004): everything stored about a
 * record — provenance, confidence, bi-temporal fields, derived scores — is
 * visible here. Superseded records stay filtered by default (Invariant 3);
 * `--history` is the explicit history request the invariant allows.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { openDatabase } from "../storage/db.js";
import { getRecord } from "../storage/records.js";
import type { ContextRecord } from "../storage/types.js";
import type { CliEnv } from "./env.js";

export const SHOW_USAGE = `Usage: agentctx show <id> [options]

Options:
  --history   allow viewing a superseded record version`;

export async function runShow(env: CliEnv, args: string[]): Promise<number> {
  if (args.includes("--help")) {
    env.io.out(SHOW_USAGE);
    return 0;
  }
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      history: { type: "boolean", default: false },
    },
  });

  const id = positionals[0];
  if (id === undefined || positionals.length !== 1) {
    env.io.err("agentctx show: exactly one record id is required");
    env.io.err(SHOW_USAGE);
    return 1;
  }
  if (!existsSync(env.dbPath)) {
    env.io.err("agentctx is not initialized — run `agentctx init` first");
    return 1;
  }

  const db = openDatabase(env.dbPath);
  try {
    const record = getRecord(db, id, { includeSuperseded: true });
    if (record === null) {
      env.io.err(`agentctx show: no record with id ${id}`);
      return 1;
    }
    if (record.supersededAt !== null && !values.history) {
      env.io.err(
        `agentctx show: record ${id} was superseded${
          record.supersededBy === null ? "" : ` by ${record.supersededBy}`
        } at ${record.supersededAt}`,
      );
      if (record.supersededBy !== null) {
        env.io.err(`run \`agentctx show ${record.supersededBy}\` for the current version,`);
      }
      env.io.err("or pass --history to view this superseded version");
      return 1;
    }
    printRecord(env, record);
  } finally {
    db.close();
  }
  return 0;
}

function printRecord(env: CliEnv, r: ContextRecord): void {
  if (r.supersededAt !== null) {
    env.io.out(
      `⚠ SUPERSEDED at ${r.supersededAt}${r.supersededBy === null ? "" : ` by ${r.supersededBy}`}`,
    );
    env.io.out("");
  }
  env.io.out(r.title);
  env.io.out("=".repeat(Math.min(r.title.length, 80)));
  env.io.out("");
  field(env, "id", r.id);
  field(env, "type", r.type);
  field(env, "scope", r.scope);
  field(
    env,
    "confidence",
    `${r.confidence}${r.reinforceCount > 0 ? ` (reinforced ×${r.reinforceCount})` : ""}`,
  );
  if (r.pinned) {
    field(env, "pinned", "yes");
  }
  field(env, "source", `${r.source}${r.sessionId === null ? "" : ` (session ${r.sessionId})`}`);
  field(env, "valid from", r.validFrom);
  field(env, "recorded at", r.recordedAt);
  if (r.lastAccessed !== null) {
    field(env, "last accessed", `${r.lastAccessed} (${r.accessCount} reads)`);
  }
  field(env, "score", r.score.toFixed(3));
  field(env, "project", r.projectId);
  env.io.out("");
  env.io.out(r.body);
}

function field(env: CliEnv, name: string, value: string): void {
  env.io.out(`${`${name}:`.padEnd(15)}${value}`);
}
