import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliEnv } from "../../src/cli/env.js";
import { CONFIG_FILE_NAME } from "../../src/config.js";

export interface TestEnv {
  env: CliEnv;
  root: string;
  stdout: string[];
  stderr: string[];
  /** Queue of answers for confirm(); empty queue answers `false` (no TTY). */
  confirmAnswers: boolean[];
  cleanup: () => void;
}

/** A fully sandboxed CliEnv rooted in a temp dir — never touches real homes. */
export function makeTestEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), "agentctx-cli-"));
  const cwd = join(root, "project");
  const agentctxHome = join(root, "agentctx-home");
  mkdirSync(cwd, { recursive: true });

  const stdout: string[] = [];
  const stderr: string[] = [];
  const confirmAnswers: boolean[] = [];

  const env: CliEnv = {
    cwd,
    agentctxHome,
    dbPath: join(agentctxHome, "agentctx.db"),
    configPath: join(agentctxHome, CONFIG_FILE_NAME),
    userSettingsPath: join(root, "home", ".claude", "settings.json"),
    projectSettingsPath: join(cwd, ".claude", "settings.json"),
    claudeJsonPath: join(root, "home", ".claude.json"),
    io: {
      out: (line) => stdout.push(line),
      err: (line) => stderr.push(line),
      confirm: async () => confirmAnswers.shift() ?? false,
    },
  };

  return {
    env,
    root,
    stdout,
    stderr,
    confirmAnswers,
    cleanup: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
