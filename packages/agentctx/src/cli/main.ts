/**
 * CLI command dispatch.
 *
 * Command modules are loaded lazily so lightweight invocations (`--help`,
 * `--version`, a misspelled command) never pay for — or fail on — the
 * native better-sqlite3 import. The `hook` command is additionally
 * short-circuited in cli.ts before this module even loads (issue 2/7: a
 * half-installed state must never break Claude Code).
 */
import { SettingsError } from "../claude/json-file.js";
import { ConfigError } from "../config.js";
import { VERSION } from "../version.js";
import { type CliEnv, defaultEnv } from "./env.js";

const HELP = `agentctx ${VERSION} — the context layer for Claude Code

Usage: agentctx <command> [options]

Commands:
  init         set up agentctx: data dir, database, Claude Code hooks, MCP server
  uninstall    remove hooks and MCP registration (add --data to delete stored context)
  config       get/set settings (llm, embeddings, modelTier, reinforceThreshold)
  reset        delete the current project's context records (asks first)
  hook <event> hook dispatcher invoked by Claude Code (not for direct use)

Run any command with --help semantics via the docs:
  https://github.com/agentctxhq/agentctx`;

export async function main(argv: string[], env: CliEnv = defaultEnv()): Promise<number> {
  const [command, ...args] = argv;

  try {
    switch (command) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        env.io.out(HELP);
        return 0;
      case "--version":
      case "-v":
      case "version":
        env.io.out(VERSION);
        return 0;
      case "init":
        return await (await import("./init.js")).runInit(env, args);
      case "uninstall":
        return await (await import("./uninstall.js")).runUninstall(env, args);
      case "config":
        return await (await import("./config-cmd.js")).runConfig(env, args);
      case "reset":
        return await (await import("./reset.js")).runReset(env, args);
      case "hook":
        // Real dispatch happens in cli.ts (hooks/runner.js) before this
        // module ever loads, with its own swallow-everything error policy.
        // This arm is defense in depth only: exit 0 silently, never let a
        // hook invocation fall through to command error handling.
        return 0;
      default:
        env.io.err(`agentctx: unknown command "${command}"`);
        env.io.err(HELP);
        return 1;
    }
  } catch (error) {
    return reportError(env, error);
  }
}

function reportError(env: CliEnv, error: unknown): number {
  if (error instanceof SettingsError || error instanceof ConfigError) {
    env.io.err(`agentctx: ${error.message}`);
    return 1;
  }
  if (isParseArgsError(error)) {
    env.io.err(`agentctx: ${(error as Error).message}`);
    return 1;
  }
  if (error instanceof Error && error.name === "StorageError") {
    env.io.err(`agentctx: ${error.message}`);
    return 1;
  }
  throw error;
}

function isParseArgsError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    typeof (error as NodeJS.ErrnoException).code === "string" &&
    ((error as NodeJS.ErrnoException).code as string).startsWith("ERR_PARSE_ARGS")
  );
}
