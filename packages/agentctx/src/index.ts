/**
 * @agentctxhq/agentctx — context layer for Claude Code.
 *
 * Public programmatic surface. The CLI entry point lives in cli.ts;
 * hooks, extraction, and MCP modules land with later v0.1 issues.
 */
export { VERSION } from "./version.js";

export * from "./storage/index.js";

export {
  type JsonObject,
  SettingsError,
  type SettingsErrorCode,
  type SurgeryResult,
  readJsonObject,
  writeJsonObject,
} from "./claude/json-file.js";
export {
  HOOK_EVENTS,
  type HookEvent,
  hookCommand,
  hookEventArg,
  installHooks,
  isAgentctxHookCommand,
  removeHooks,
} from "./claude/settings.js";
export {
  MCP_SERVER_NAME,
  mcpServerEntry,
  registerMcpServer,
  unregisterMcpServer,
} from "./claude/mcp.js";
export {
  type AgentctxConfig,
  CONFIG_FILE_NAME,
  CONFIG_KEYS,
  ConfigError,
  DEFAULT_CONFIG,
  MODEL_TIERS,
  type ModelTier,
  ensureConfigFile,
  isConfigKey,
  loadConfig,
  parseConfigValue,
  saveConfig,
} from "./config.js";
export {
  PROFILE_TITLES,
  type ProfileEntry,
  type ProfileRefreshResult,
  detectProjectProfile,
  refreshProjectProfile,
} from "./profile/detect.js";
