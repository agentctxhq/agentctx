/**
 * `agentctx uninstall` — full removal, no residue (ADR-016).
 *
 * Removes hooks from both user- and project-scope settings, unregisters the
 * MCP server, and — only with `--data` — deletes the data directory after
 * confirmation. Each step is surgical and idempotent; user settings outside
 * our keys are untouched.
 */
import { existsSync, rmSync } from "node:fs";
import { parseArgs } from "node:util";
import { unregisterMcpServer } from "../claude/mcp.js";
import { removeHooks } from "../claude/settings.js";
import type { CliEnv } from "./env.js";

export const UNINSTALL_USAGE = `Usage: agentctx uninstall [options]

Options:
  --data    also delete the data directory (~/.agentctx) — asks first
  --force   skip the confirmation prompt (required without a TTY)`;

export async function runUninstall(env: CliEnv, args: string[]): Promise<number> {
  if (args.includes("--help")) {
    env.io.out(UNINSTALL_USAGE);
    return 0;
  }
  const { values } = parseArgs({
    args,
    options: {
      data: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
    },
  });

  for (const settingsPath of [env.userSettingsPath, env.projectSettingsPath]) {
    const result = removeHooks(settingsPath);
    if (result.changed) {
      env.io.out(`✓ hooks removed from ${settingsPath}`);
    } else if (existsSync(settingsPath)) {
      env.io.out(`· no hooks registered in ${settingsPath}`);
    }
  }

  if (unregisterMcpServer(env.claudeJsonPath).changed) {
    env.io.out(`✓ MCP server "agentctx" removed from ${env.claudeJsonPath}`);
  }

  if (values.data) {
    if (!existsSync(env.agentctxHome)) {
      env.io.out(`· no data directory at ${env.agentctxHome}`);
    } else {
      const confirmed =
        values.force ||
        (await env.io.confirm(
          `Delete ${env.agentctxHome} and all stored context? This cannot be undone.`,
        ));
      if (!confirmed) {
        env.io.err("aborted: data directory kept (pass --force to skip the prompt)");
        return 1;
      }
      rmSync(env.agentctxHome, { recursive: true, force: true });
      env.io.out(`✓ data directory ${env.agentctxHome} deleted`);
    }
  }

  env.io.out(
    "agentctx is uninstalled. Open Claude Code sessions keep running hooks until restarted.",
  );
  return 0;
}
