/**
 * agentctx settings — `~/.agentctx/config.json`.
 *
 * Plain JSON in the data directory: inspectable with any editor, no extra
 * format on the install path. Loading is lenient (invalid or missing values
 * fall back to defaults so a hand-edited file never breaks hooks); setting
 * is strict (bad keys/values are rejected with a clear error). Unknown keys
 * in the file are preserved across writes for forward compatibility.
 */
import { SettingsError, readJsonObject, writeJsonObject } from "./claude/json-file.js";

export const CONFIG_FILE_NAME = "config.json";

export const MODEL_TIERS = ["default", "quality"] as const;

export type ModelTier = (typeof MODEL_TIERS)[number];

export interface AgentctxConfig {
  /** LLM extraction at session end (ADR-009). `false` = deterministic capture only. */
  llm: boolean;
  /** Offline embedding work (ADR-006). `false` = FTS5-only, no model download. */
  embeddings: boolean;
  /** `quality` opts into the slower, higher-quality model tier (ADR-006). */
  modelTier: ModelTier;
  /** Sessions before an inferred record upgrades to reinforced (SPEC §3.3). */
  reinforceThreshold: number;
}

export const DEFAULT_CONFIG: AgentctxConfig = {
  llm: true,
  embeddings: true,
  modelTier: "default",
  reinforceThreshold: 3,
};

export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as readonly (keyof AgentctxConfig)[];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Load effective config: defaults overlaid with valid values from the file. */
export function loadConfig(path: string): AgentctxConfig {
  const raw = readJsonObject(path) ?? {};
  const config: AgentctxConfig = { ...DEFAULT_CONFIG };
  if (typeof raw.llm === "boolean") {
    config.llm = raw.llm;
  }
  if (typeof raw.embeddings === "boolean") {
    config.embeddings = raw.embeddings;
  }
  if (
    typeof raw.modelTier === "string" &&
    (MODEL_TIERS as readonly string[]).includes(raw.modelTier)
  ) {
    config.modelTier = raw.modelTier as ModelTier;
  }
  if (
    typeof raw.reinforceThreshold === "number" &&
    Number.isInteger(raw.reinforceThreshold) &&
    raw.reinforceThreshold >= 1
  ) {
    config.reinforceThreshold = raw.reinforceThreshold;
  }
  return config;
}

/**
 * Persist `updates` into the config file, preserving unknown keys.
 * Returns the new effective config.
 */
export function saveConfig(path: string, updates: Partial<AgentctxConfig>): AgentctxConfig {
  const raw = readJsonObject(path) ?? {};
  for (const [key, value] of Object.entries(updates)) {
    raw[key] = value;
  }
  writeJsonObject(path, raw);
  return loadConfig(path);
}

/** Create the config file with defaults when it does not exist yet. */
export function ensureConfigFile(path: string): boolean {
  let existing: ReturnType<typeof readJsonObject>;
  try {
    existing = readJsonObject(path);
  } catch (error) {
    if (error instanceof SettingsError) {
      existing = null; // corrupt file → overwrite with defaults, consistent with lenient loadConfig
    } else {
      throw error;
    }
  }
  if (existing !== null) {
    return false;
  }
  writeJsonObject(path, { ...DEFAULT_CONFIG });
  return true;
}

export function isConfigKey(key: string): key is keyof AgentctxConfig {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

/** Parse a CLI-provided string into a typed, validated config value. */
export function parseConfigValue(
  key: keyof AgentctxConfig,
  raw: string,
): AgentctxConfig[typeof key] {
  switch (key) {
    case "llm":
    case "embeddings": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new ConfigError(`"${key}" must be true or false, got "${raw}"`);
    }
    case "modelTier": {
      if ((MODEL_TIERS as readonly string[]).includes(raw)) {
        return raw as ModelTier;
      }
      throw new ConfigError(`"modelTier" must be one of: ${MODEL_TIERS.join(", ")}, got "${raw}"`);
    }
    case "reinforceThreshold": {
      const value = Number(raw);
      if (!Number.isInteger(value) || value < 1) {
        throw new ConfigError(`"reinforceThreshold" must be an integer ≥ 1, got "${raw}"`);
      }
      return value;
    }
  }
}
