/**
 * `agentctx config` — read and write `~/.agentctx/config.json`.
 *
 * Two forms: explicit `get`/`set` subcommands, plus the documented flag
 * sugar (`--no-llm`, `--llm`, `--no-embeddings`, `--embeddings`) from the
 * roadmap. Loading is lenient, setting is validated (config.ts).
 */
import {
  type AgentctxConfig,
  CONFIG_KEYS,
  ConfigError,
  isConfigKey,
  loadConfig,
  parseConfigValue,
  saveConfig,
} from "../config.js";
import type { CliEnv } from "./env.js";

export const CONFIG_USAGE = `Usage:
  agentctx config                       show all settings
  agentctx config get [key]            show all or one setting
  agentctx config set <key> <value>    change a setting
  agentctx config --no-llm | --llm
  agentctx config --no-embeddings | --embeddings

Keys:
  llm                 LLM extraction at session end (true/false, default true)
  embeddings          offline embedding work (true/false, default true)
  modelTier           default | quality
  reinforceThreshold  sessions before inferred → reinforced (integer ≥ 1, default 3)`;

/** The flag sugar from the roadmap, mapped onto config keys. */
const FLAG_SHORTCUTS: Record<string, Partial<AgentctxConfig>> = {
  "--no-llm": { llm: false },
  "--llm": { llm: true },
  "--no-embeddings": { embeddings: false },
  "--embeddings": { embeddings: true },
};

export async function runConfig(env: CliEnv, args: string[]): Promise<number> {
  const [first, ...rest] = args;

  if (first === undefined) {
    printConfig(env, loadConfig(env.configPath));
    return 0;
  }

  const shortcut = FLAG_SHORTCUTS[first];
  if (shortcut !== undefined) {
    const updated = saveConfig(env.configPath, shortcut);
    printConfig(env, updated, Object.keys(shortcut));
    return 0;
  }

  if (first === "get") {
    const [key] = rest;
    const config = loadConfig(env.configPath);
    if (key === undefined) {
      printConfig(env, config);
      return 0;
    }
    if (!isConfigKey(key)) {
      throw new ConfigError(`unknown config key "${key}" — keys: ${CONFIG_KEYS.join(", ")}`);
    }
    env.io.out(String(config[key]));
    return 0;
  }

  if (first === "set") {
    const [key, value] = rest;
    if (key === undefined || value === undefined) {
      env.io.err(CONFIG_USAGE);
      return 1;
    }
    if (!isConfigKey(key)) {
      throw new ConfigError(`unknown config key "${key}" — keys: ${CONFIG_KEYS.join(", ")}`);
    }
    const updated = saveConfig(env.configPath, { [key]: parseConfigValue(key, value) });
    printConfig(env, updated, [key]);
    return 0;
  }

  env.io.err(CONFIG_USAGE);
  return 1;
}

function printConfig(env: CliEnv, config: AgentctxConfig, onlyKeys?: string[]): void {
  for (const key of CONFIG_KEYS) {
    if (onlyKeys === undefined || onlyKeys.includes(key)) {
      env.io.out(`${key} = ${config[key]}`);
    }
  }
}
