/**
 * @agentctxhq/agentctx — context layer for Claude Code.
 *
 * Public programmatic surface. The CLI entry point lives in cli.ts;
 * extraction and MCP modules land with later v0.1 issues.
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
// Hook-layer contracts shared with consolidation (issue 4/7) and `agentctx status`.
export {
  DIGEST_SECTION_ORDER,
  type DigestFile,
  type DigestSection,
  SESSION_START_MAX_TOKENS,
  composeDigest,
  digestFilePath,
  readDigestFile,
} from "./hooks/digest.js";
export { dedupFilePath } from "./hooks/dedup.js";
export { type HookEnv, defaultHookEnv } from "./hooks/env.js";
export { runHook } from "./hooks/runner.js";
export { CHARS_PER_TOKEN, estimateTokens, truncateToTokens } from "./hooks/tokens.js";
export {
  PROMPT_SUBMIT_MAX_CHARS,
  PROMPT_SUBMIT_MAX_TOKENS,
  PROMPT_SUBMIT_TOP_K,
} from "./hooks/user-prompt-submit.js";
export {
  PROFILE_TITLES,
  type ProfileEntry,
  type ProfileRefreshResult,
  detectProjectProfile,
  refreshProjectProfile,
} from "./profile/detect.js";
