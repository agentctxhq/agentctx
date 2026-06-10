import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsError } from "../../src/claude/json-file.js";
import {
  MCP_SERVER_NAME,
  mcpServerEntry,
  registerMcpServer,
  unregisterMcpServer,
} from "../../src/claude/mcp.js";

let dir: string;
let claudeJsonPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentctx-mcp-"));
  claudeJsonPath = join(dir, ".claude.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(claudeJsonPath, "utf8"));
}

describe("registerMcpServer", () => {
  it("creates the file with a PATH-resolved stdio entry", () => {
    expect(registerMcpServer(claudeJsonPath).changed).toBe(true);
    expect(read()).toEqual({
      mcpServers: { [MCP_SERVER_NAME]: { type: "stdio", command: "agentctx", args: ["mcp"] } },
    });
  });

  it("is idempotent and repairs a drifted entry", () => {
    registerMcpServer(claudeJsonPath);
    expect(registerMcpServer(claudeJsonPath).changed).toBe(false);

    const config = read();
    (config.mcpServers as Record<string, unknown>)[MCP_SERVER_NAME] = {
      type: "stdio",
      command: "/old/pinned/path/agentctx",
    };
    writeFileSync(claudeJsonPath, JSON.stringify(config), { encoding: "utf8" });

    expect(registerMcpServer(claudeJsonPath).changed).toBe(true);
    expect((read().mcpServers as Record<string, unknown>)[MCP_SERVER_NAME]).toEqual(
      mcpServerEntry(),
    );
  });

  it("preserves other servers and unrelated keys", () => {
    writeFileSync(
      claudeJsonPath,
      JSON.stringify({
        numStartups: 42,
        mcpServers: { github: { type: "http", url: "https://example.com" } },
      }),
      { encoding: "utf8" },
    );

    registerMcpServer(claudeJsonPath);
    const config = read();
    expect(config.numStartups).toBe(42);
    expect((config.mcpServers as Record<string, unknown>).github).toEqual({
      type: "http",
      url: "https://example.com",
    });
  });

  it("refuses to touch invalid JSON or unexpected shapes", () => {
    writeFileSync(claudeJsonPath, "not json", { encoding: "utf8" });
    expect(() => registerMcpServer(claudeJsonPath)).toThrow(SettingsError);

    writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: [] }), { encoding: "utf8" });
    expect(() => registerMcpServer(claudeJsonPath)).toThrow(SettingsError);
  });
});

describe("unregisterMcpServer", () => {
  it("is a no-op when the file or entry is missing", () => {
    expect(unregisterMcpServer(claudeJsonPath).changed).toBe(false);

    writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { github: {} } }), {
      encoding: "utf8",
    });
    expect(unregisterMcpServer(claudeJsonPath).changed).toBe(false);
  });

  it("removes only our entry", () => {
    writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { github: { type: "http" } } }), {
      encoding: "utf8",
    });
    registerMcpServer(claudeJsonPath);

    expect(unregisterMcpServer(claudeJsonPath).changed).toBe(true);
    expect(read().mcpServers).toEqual({ github: { type: "http" } });
  });
});
