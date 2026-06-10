/**
 * `agentctx init` — the single explicit setup step (ADR-016).
 *
 * Creates the data directory and database, registers hooks and the MCP
 * server via surgical settings edits, and auto-detects the project profile.
 * Idempotent: re-running repairs a partial install and refreshes the
 * profile, nothing else changes. No postinstall scripts, ever.
 */
import { parseArgs } from "node:util";
import { registerMcpServer } from "../claude/mcp.js";
import { installHooks } from "../claude/settings.js";
import { ensureConfigFile } from "../config.js";
import { detectProjectProfile, refreshProjectProfile } from "../profile/detect.js";
import { openDatabase } from "../storage/db.js";
import { resolveProjectId } from "../storage/namespace.js";
import type { CliEnv } from "./env.js";

export const INIT_USAGE = `Usage: agentctx init [options]

Options:
  --project     register hooks in this project's .claude/settings.json
                instead of the user-scope ~/.claude/settings.json
  --no-mcp      skip MCP server registration
  --no-profile  skip project profile detection`;

export async function runInit(env: CliEnv, args: string[]): Promise<number> {
  // No `allowNegative` — it needs Node 22+, we support ≥20.
  const { values } = parseArgs({
    args,
    options: {
      project: { type: "boolean", default: false },
      "no-mcp": { type: "boolean", default: false },
      "no-profile": { type: "boolean", default: false },
    },
  });

  // 1. Data directory + database (openDatabase creates both, idempotently).
  const db = openDatabase(env.dbPath);
  try {
    env.io.out(`✓ database ready at ${env.dbPath}`);

    if (ensureConfigFile(env.configPath)) {
      env.io.out(`✓ default config written to ${env.configPath}`);
    }

    // 2. Hooks — user scope by default, project scope on request.
    const settingsPath = values.project ? env.projectSettingsPath : env.userSettingsPath;
    const hooks = installHooks(settingsPath);
    env.io.out(
      hooks.changed
        ? `✓ hooks registered in ${settingsPath}`
        : `✓ hooks already registered in ${settingsPath}`,
    );

    // 3. MCP server, always user scope (SPEC §2.1).
    if (!values["no-mcp"]) {
      const mcp = registerMcpServer(env.claudeJsonPath);
      env.io.out(
        mcp.changed
          ? `✓ MCP server "agentctx" registered in ${env.claudeJsonPath}`
          : `✓ MCP server "agentctx" already registered in ${env.claudeJsonPath}`,
      );
    }

    // 4. Project profile detection (rule-based, never fails init).
    if (!values["no-profile"]) {
      const entries = detectProjectProfile(env.cwd);
      if (entries.length === 0) {
        env.io.out("· no project profile detected (no recognized manifest in cwd)");
      } else {
        const projectId = resolveProjectId(env.cwd);
        const result = refreshProjectProfile(db, projectId, entries);
        const written = result.created.length + result.refreshed.length;
        env.io.out(
          written > 0
            ? `✓ project profile: ${describeRefresh(result.created, result.refreshed)}`
            : "✓ project profile up to date",
        );
      }
    }
  } finally {
    db.close();
  }

  env.io.out("agentctx is installed. Hooks take effect in new Claude Code sessions.");
  return 0;
}

function describeRefresh(created: string[], refreshed: string[]): string {
  const parts: string[] = [];
  if (created.length > 0) {
    parts.push(`recorded ${created.join(", ")}`);
  }
  if (refreshed.length > 0) {
    parts.push(`refreshed ${refreshed.join(", ")}`);
  }
  return parts.join("; ");
}
