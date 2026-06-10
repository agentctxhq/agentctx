import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MCP_SERVER_NAME } from "../../src/claude/mcp.js";
import { HOOK_EVENTS } from "../../src/claude/settings.js";
import { main } from "../../src/cli/main.js";
import { PROFILE_TITLES } from "../../src/profile/detect.js";
import { openDatabase } from "../../src/storage/db.js";
import { resolveProjectId } from "../../src/storage/namespace.js";
import { insertRecord, listRecords } from "../../src/storage/records.js";
import { GLOBAL_PROJECT_ID } from "../../src/storage/types.js";
import { type TestEnv, makeTestEnv } from "./helpers.js";

let t: TestEnv;

beforeEach(() => {
  t = makeTestEnv();
});

afterEach(() => {
  t.cleanup();
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("agentctx init", () => {
  it("bootstraps db, config, hooks (user scope), MCP, and project profile", async () => {
    writeFileSync(
      join(t.env.cwd, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }),
      { encoding: "utf8" },
    );

    const code = await main(["init"], t.env);
    expect(code).toBe(0);

    expect(existsSync(t.env.dbPath)).toBe(true);
    expect(existsSync(t.env.configPath)).toBe(true);

    const settings = readJson(t.env.userSettingsPath);
    expect(Object.keys(settings.hooks as object).sort()).toEqual([...HOOK_EVENTS].sort());

    const claudeJson = readJson(t.env.claudeJsonPath);
    expect((claudeJson.mcpServers as Record<string, unknown>)[MCP_SERVER_NAME]).toBeDefined();

    const db = openDatabase(t.env.dbPath);
    try {
      const profile = listRecords(db, resolveProjectId(t.env.cwd), { type: "profile" });
      expect(profile.map((r) => r.title)).toContain(PROFILE_TITLES.commands);
    } finally {
      db.close();
    }
  });

  it("writes hooks to project scope with --project and is idempotent", async () => {
    expect(await main(["init", "--project", "--no-mcp", "--no-profile"], t.env)).toBe(0);
    expect(existsSync(t.env.userSettingsPath)).toBe(false);

    const first = readFileSync(t.env.projectSettingsPath, "utf8");
    expect(await main(["init", "--project", "--no-mcp", "--no-profile"], t.env)).toBe(0);
    expect(readFileSync(t.env.projectSettingsPath, "utf8")).toBe(first);
  });

  it("fails cleanly when a settings file is corrupt, without overwriting it", async () => {
    mkdirSync(dirname(t.env.userSettingsPath), { recursive: true });
    writeFileSync(t.env.userSettingsPath, "{ broken", { encoding: "utf8" });

    const code = await main(["init"], t.env);
    expect(code).toBe(1);
    expect(t.stderr.join("\n")).toContain("not valid JSON");
    expect(readFileSync(t.env.userSettingsPath, "utf8")).toBe("{ broken");
  });
});

describe("agentctx uninstall", () => {
  it("removes hooks and MCP registration, leaving no residue", async () => {
    await main(["init", "--no-profile"], t.env);
    await main(["init", "--project", "--no-mcp", "--no-profile"], t.env);

    expect(await main(["uninstall"], t.env)).toBe(0);

    expect(readJson(t.env.userSettingsPath)).toEqual({});
    expect(readJson(t.env.projectSettingsPath)).toEqual({});
    expect(readJson(t.env.claudeJsonPath)).toEqual({});
    // data dir kept without --data
    expect(existsSync(t.env.agentctxHome)).toBe(true);
  });

  it("deletes the data directory only with --data and confirmation", async () => {
    await main(["init", "--no-profile"], t.env);

    // declined (no answer queued → false, the no-TTY behavior)
    expect(await main(["uninstall", "--data"], t.env)).toBe(1);
    expect(existsSync(t.env.agentctxHome)).toBe(true);

    t.confirmAnswers.push(true);
    expect(await main(["uninstall", "--data"], t.env)).toBe(0);
    expect(existsSync(t.env.agentctxHome)).toBe(false);
  });

  it("--force skips the prompt", async () => {
    await main(["init", "--no-profile"], t.env);
    expect(await main(["uninstall", "--data", "--force"], t.env)).toBe(0);
    expect(existsSync(t.env.agentctxHome)).toBe(false);
  });
});

describe("agentctx config", () => {
  it("prints defaults, sets and gets values", async () => {
    expect(await main(["config"], t.env)).toBe(0);
    expect(t.stdout).toContain("llm = true");

    expect(await main(["config", "set", "reinforceThreshold", "5"], t.env)).toBe(0);
    t.stdout.length = 0;
    expect(await main(["config", "get", "reinforceThreshold"], t.env)).toBe(0);
    expect(t.stdout).toEqual(["5"]);
  });

  it("supports the documented flag sugar", async () => {
    expect(await main(["config", "--no-llm"], t.env)).toBe(0);
    t.stdout.length = 0;
    expect(await main(["config", "get", "llm"], t.env)).toBe(0);
    expect(t.stdout).toEqual(["false"]);

    expect(await main(["config", "--llm"], t.env)).toBe(0);
    t.stdout.length = 0;
    expect(await main(["config", "get", "llm"], t.env)).toBe(0);
    expect(t.stdout).toEqual(["true"]);
  });

  it("rejects unknown keys and bad values without writing", async () => {
    expect(await main(["config", "set", "daemon", "true"], t.env)).toBe(1);
    expect(t.stderr.join("\n")).toContain("unknown config key");

    expect(await main(["config", "set", "reinforceThreshold", "zero"], t.env)).toBe(1);
    expect(existsSync(t.env.configPath)).toBe(false);
  });
});

describe("agentctx reset", () => {
  it("deletes only the current project's records, after confirmation", async () => {
    await main(["init", "--no-profile", "--no-mcp"], t.env);
    const projectId = resolveProjectId(t.env.cwd);

    const db = openDatabase(t.env.dbPath);
    insertRecord(db, {
      projectId,
      type: "decision",
      title: "ours",
      body: "project-scoped record",
      source: "cli",
    });
    insertRecord(db, {
      projectId: "other-project",
      type: "decision",
      title: "theirs",
      body: "another project's record",
      source: "cli",
    });
    insertRecord(db, {
      projectId: GLOBAL_PROJECT_ID,
      type: "preference",
      title: "global",
      body: "a global preference",
      source: "cli",
      scope: "global",
    });
    db.close();

    // declined → nothing deleted
    expect(await main(["reset"], t.env)).toBe(1);

    t.confirmAnswers.push(true);
    expect(await main(["reset"], t.env)).toBe(0);

    const check = openDatabase(t.env.dbPath);
    try {
      expect(listRecords(check, projectId)).toHaveLength(1); // the global record only
      expect(listRecords(check, "other-project", { type: "decision" })).toHaveLength(1);
      expect(listRecords(check, GLOBAL_PROJECT_ID)).toHaveLength(1);
    } finally {
      check.close();
    }
  });

  it("handles supersession chains without FK violations", async () => {
    await main(["init", "--no-profile", "--no-mcp"], t.env);
    const projectId = resolveProjectId(t.env.cwd);

    const db = openDatabase(t.env.dbPath);
    const a = insertRecord(db, {
      projectId,
      type: "decision",
      title: "REST",
      body: "we use REST",
      source: "cli",
    });
    insertRecord(db, {
      projectId,
      type: "decision",
      title: "gRPC",
      body: "we moved to gRPC",
      source: "cli",
      supersedes: a.id,
    });
    db.close();

    expect(await main(["reset", "--force"], t.env)).toBe(0);

    const check = openDatabase(t.env.dbPath);
    try {
      expect(
        listRecords(check, projectId, { includeSuperseded: true, type: "decision" }),
      ).toHaveLength(0);
    } finally {
      check.close();
    }
  });

  it("is a no-op on an empty project", async () => {
    await main(["init", "--no-profile", "--no-mcp"], t.env);
    expect(await main(["reset"], t.env)).toBe(0);
    expect(t.stdout.join("\n")).toContain("nothing to reset");
  });
});

describe("dispatch", () => {
  it("prints help and version without touching the filesystem", async () => {
    expect(await main([], t.env)).toBe(0);
    expect(await main(["--version"], t.env)).toBe(0);
    expect(existsSync(t.env.agentctxHome)).toBe(false);
  });

  it("rejects unknown commands and unknown flags", async () => {
    expect(await main(["frobnicate"], t.env)).toBe(1);
    expect(t.stderr.join("\n")).toContain('unknown command "frobnicate"');

    expect(await main(["init", "--bogus"], t.env)).toBe(1);
  });

  it("hook returns 0 silently for any event", async () => {
    expect(await main(["hook", "session-start"], t.env)).toBe(0);
    expect(await main(["hook", "not-a-real-event"], t.env)).toBe(0);
    expect(await main(["hook"], t.env)).toBe(0);
    expect(t.stdout).toEqual([]);
    expect(t.stderr).toEqual([]);
  });
});
