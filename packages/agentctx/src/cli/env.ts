/**
 * CLI environment: every path a command touches and every way it talks to
 * the user, in one injectable object — commands never reach for `homedir()`
 * or `process.stdout` directly, so tests run them against temp directories.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { CONFIG_FILE_NAME } from "../config.js";

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Ask a yes/no question. Must resolve `false` when no TTY is attached. */
  confirm(question: string): Promise<boolean>;
}

export interface CliEnv {
  cwd: string;
  /** Data directory, default `~/.agentctx` (SPEC §2.4). */
  agentctxHome: string;
  dbPath: string;
  configPath: string;
  /** User-scope Claude Code settings: `~/.claude/settings.json`. */
  userSettingsPath: string;
  /** Project-scope Claude Code settings: `<cwd>/.claude/settings.json`. */
  projectSettingsPath: string;
  /** User-scope MCP registration lives in `~/.claude.json`. */
  claudeJsonPath: string;
  io: CliIo;
}

/**
 * Build the real environment. `AGENTCTX_HOME` overrides the data directory
 * (used by tests and sandboxed setups); Claude Code paths are fixed.
 */
export function defaultEnv(cwd: string = process.cwd()): CliEnv {
  const home = homedir();
  const agentctxHome = process.env.AGENTCTX_HOME ?? join(home, ".agentctx");
  return {
    cwd,
    agentctxHome,
    dbPath: join(agentctxHome, "agentctx.db"),
    configPath: join(agentctxHome, CONFIG_FILE_NAME),
    userSettingsPath: join(home, ".claude", "settings.json"),
    projectSettingsPath: join(cwd, ".claude", "settings.json"),
    claudeJsonPath: join(home, ".claude.json"),
    io: {
      out: (line) => console.log(line),
      err: (line) => console.error(line),
      confirm: confirmViaTty,
    },
  };
}

async function confirmViaTty(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
