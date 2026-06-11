/**
 * MCP server registration at user scope (ADR-016, SPEC §2.1).
 *
 * The `claude mcp add --scope user`-equivalent: a surgical edit of the
 * `mcpServers` map in `~/.claude.json`. The registered command is
 * PATH-resolved `agentctx mcp` — the stdio server in ../mcp/run.ts.
 */
import {
  type JsonObject,
  SettingsError,
  type SurgeryResult,
  isJsonObject,
  readJsonObject,
  writeJsonObject,
} from "./json-file.js";

export const MCP_SERVER_NAME = "agentctx";

/** The stdio server entry we register (SPEC §2.1: stdio, user scope). */
export function mcpServerEntry(): JsonObject {
  return { type: "stdio", command: "agentctx", args: ["mcp"] };
}

/** Register (or repair) the agentctx MCP server entry. Idempotent. */
export function registerMcpServer(path: string): SurgeryResult {
  const config = readJsonObject(path) ?? {};
  const servers = ensureServersObject(config, path);

  const desired = mcpServerEntry();
  if (JSON.stringify(servers[MCP_SERVER_NAME]) === JSON.stringify(desired)) {
    return { changed: false };
  }
  servers[MCP_SERVER_NAME] = desired;
  writeJsonObject(path, config);
  return { changed: true };
}

/** Remove the agentctx MCP server entry. Idempotent; everything else is preserved. */
export function unregisterMcpServer(path: string): SurgeryResult {
  const config = readJsonObject(path);
  if (config === null || !("mcpServers" in config)) {
    return { changed: false };
  }
  const servers = ensureServersObject(config, path);
  if (!(MCP_SERVER_NAME in servers)) {
    return { changed: false };
  }
  delete servers[MCP_SERVER_NAME];
  if (Object.keys(servers).length === 0) {
    // biome-ignore lint/performance/noDelete: removing the key from the serialized file is the point
    delete config.mcpServers;
  }
  writeJsonObject(path, config);
  return { changed: true };
}

function ensureServersObject(config: JsonObject, path: string): JsonObject {
  const existing = config.mcpServers;
  if (existing === undefined) {
    const servers: JsonObject = {};
    config.mcpServers = servers;
    return servers;
  }
  if (!isJsonObject(existing)) {
    throw new SettingsError(
      "unexpected_shape",
      path,
      `${path} has a "mcpServers" key that is not an object — agentctx will not modify it`,
    );
  }
  return existing;
}
