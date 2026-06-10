import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_CONFIG,
  ensureConfigFile,
  loadConfig,
  parseConfigValue,
  saveConfig,
} from "../src/config.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentctx-config-"));
  configPath = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when the file is missing", () => {
    expect(loadConfig(configPath)).toEqual(DEFAULT_CONFIG);
  });

  it("overlays valid values and ignores invalid ones (lenient load)", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ llm: false, reinforceThreshold: "garbage", modelTier: "nope" }),
      { encoding: "utf8" },
    );
    expect(loadConfig(configPath)).toEqual({ ...DEFAULT_CONFIG, llm: false });
  });
});

describe("saveConfig", () => {
  it("round-trips values", () => {
    saveConfig(configPath, { llm: false, reinforceThreshold: 5 });
    expect(loadConfig(configPath)).toEqual({
      ...DEFAULT_CONFIG,
      llm: false,
      reinforceThreshold: 5,
    });
  });

  it("preserves unknown keys for forward compatibility", () => {
    writeFileSync(configPath, JSON.stringify({ futureKey: { nested: true } }), {
      encoding: "utf8",
    });
    saveConfig(configPath, { embeddings: false });

    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    expect(raw.futureKey).toEqual({ nested: true });
    expect(raw.embeddings).toBe(false);
  });
});

describe("ensureConfigFile", () => {
  it("creates defaults once and never overwrites", () => {
    expect(ensureConfigFile(configPath)).toBe(true);
    saveConfig(configPath, { llm: false });
    expect(ensureConfigFile(configPath)).toBe(false);
    expect(loadConfig(configPath).llm).toBe(false);
  });
});

describe("parseConfigValue", () => {
  it("parses booleans, tiers, and thresholds strictly", () => {
    expect(parseConfigValue("llm", "true")).toBe(true);
    expect(parseConfigValue("embeddings", "false")).toBe(false);
    expect(parseConfigValue("modelTier", "quality")).toBe("quality");
    expect(parseConfigValue("reinforceThreshold", "4")).toBe(4);
  });

  it("rejects invalid values with ConfigError", () => {
    expect(() => parseConfigValue("llm", "maybe")).toThrow(ConfigError);
    expect(() => parseConfigValue("modelTier", "turbo")).toThrow(ConfigError);
    expect(() => parseConfigValue("reinforceThreshold", "0")).toThrow(ConfigError);
    expect(() => parseConfigValue("reinforceThreshold", "2.5")).toThrow(ConfigError);
  });
});
