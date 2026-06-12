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
// Dependency-free by design — safe to import statically even when the
// better-sqlite3 native module cannot load (see node-support.ts).
import { describeNativeLoadError } from "./node-support.js";

const HELP = `agentctx ${VERSION} — the context layer for Claude Code

Usage: agentctx <command> [options]

Commands:
  init         set up agentctx: data dir, database, Claude Code hooks, MCP server
  uninstall    remove hooks and MCP registration (add --data to delete stored context)
  status       project context summary, injection token cost, extraction cost
  search       FTS5 search of the context store from the terminal
  show <id>    pretty-print a full record
  export       render the context store as organized Markdown
  profile      show/edit/clear global developer preferences
  config       get/set settings (llm, embeddings, modelTier, reinforceThreshold)
  reset        delete the current project's context records (asks first)
  sync         compare context store against CLAUDE.md and propose additions
  extract      LLM extraction from a session transcript (spawned by the Stop hook)
  consolidate  offline pass: confidence lifecycle, scores, SessionStart digest
  mcp          MCP stdio server exposing the ctx_* tools (started by Claude Code)
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
      case "init": {
        // OQ-1: fail init with a clear message on unsupported Node, before
        // anything tries to load the better-sqlite3 native module.
        const unsupported = (await import("./node-support.js")).unsupportedNodeReason();
        if (unsupported !== null) {
          env.io.err(`agentctx: ${unsupported}`);
          return 1;
        }
        return await (await import("./init.js")).runInit(env, args);
      }
      case "uninstall":
        return await (await import("./uninstall.js")).runUninstall(env, args);
      case "status":
        return await (await import("./status.js")).runStatus(env, args);
      case "search":
        return await (await import("./search.js")).runSearch(env, args);
      case "show":
        return await (await import("./show.js")).runShow(env, args);
      case "export":
        return await (await import("./export.js")).runExport(env, args);
      case "profile":
        return await (await import("./profile-cmd.js")).runProfile(env, args);
      case "config":
        return await (await import("./config-cmd.js")).runConfig(env, args);
      case "reset":
        return await (await import("./reset.js")).runReset(env, args);
      case "sync":
        return await (await import("./sync.js")).runSync(env, args);
      case "extract":
        return await (await import("../extract/run.js")).runExtract(env, args);
      case "consolidate":
        return await (await import("../consolidate/run.js")).runConsolidate(env, args);
      case "mcp":
        return await (await import("../mcp/run.js")).runMcp(env, args);
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
  // A failed better-sqlite3 native load (ABI mismatch after a Node switch,
  // or a Node major without prebuilds — OQ-1) surfaces as an import error
  // from any storage-touching command. Translate it instead of a stack dump.
  const nativeLoad = describeNativeLoadError(error);
  if (nativeLoad !== null) {
    env.io.err(`agentctx: ${nativeLoad}`);
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
