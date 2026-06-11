import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_FILE_NAME } from "../../src/config.js";
import { dedupFilePath } from "../../src/hooks/dedup.js";
import { resolveProjectId } from "../../src/storage/namespace.js";
import { type HookTestEnv, makeHookEnv } from "./helpers.js";

let t: HookTestEnv;

beforeEach(() => {
  t = makeHookEnv();
});

afterEach(() => {
  t.cleanup();
});

function writeConfig(config: Record<string, unknown>): void {
  const path = join(t.env.agentctxHome, CONFIG_FILE_NAME);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config), "utf8");
}

describe("hook stop", () => {
  it("spawns a detached extract subprocess and returns immediately", async () => {
    expect(
      await t.run("stop", {
        session_id: "sess-1",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: t.cwd,
      }),
    ).toBe(0);
    expect(t.spawns).toEqual([
      ["extract", "--session-id", "sess-1", "--transcript", "/tmp/transcript.jsonl"],
    ]);
  });

  it("skips extraction when llm is disabled (SPEC §8 rung 3)", async () => {
    writeConfig({ llm: false });
    await t.run("stop", { session_id: "s", transcript_path: "/t.jsonl", cwd: t.cwd });
    expect(t.spawns).toEqual([]);
  });

  it("treats a corrupt config as defaults (llm on)", async () => {
    mkdirSync(t.env.agentctxHome, { recursive: true });
    writeFileSync(join(t.env.agentctxHome, CONFIG_FILE_NAME), "not json", "utf8");
    await t.run("stop", { session_id: "s", transcript_path: "/t.jsonl", cwd: t.cwd });
    expect(t.spawns).toHaveLength(1);
  });

  it("does nothing without a session id or transcript", async () => {
    await t.run("stop", { cwd: t.cwd });
    expect(t.spawns).toEqual([]);
  });
});

describe("hook session-end", () => {
  it("marks the session ended, removes the dedup file, and spawns consolidate", async () => {
    const db = t.openDb();
    db.prepare("INSERT INTO sessions (session_id, project_id, started_at) VALUES (?, ?, ?)").run(
      "sess-1",
      t.projectId,
      new Date().toISOString(),
    );
    db.close();
    const dedupPath = dedupFilePath(t.env.tmpDir, "sess-1");
    writeFileSync(dedupPath, JSON.stringify(["id1"]), "utf8");

    expect(await t.run("session-end", { session_id: "sess-1", cwd: t.cwd })).toBe(0);

    expect(t.spawns).toEqual([["consolidate"]]);
    expect(existsSync(dedupPath)).toBe(false);
    const check = t.openDb();
    try {
      const row = check
        .prepare("SELECT ended_at FROM sessions WHERE session_id = ?")
        .get("sess-1") as { ended_at: string | null };
      expect(row.ended_at).not.toBeNull();
    } finally {
      check.close();
    }
  });

  it("still spawns consolidate when there is no database", async () => {
    await t.run("session-end", { session_id: "sess-1", cwd: t.cwd });
    expect(t.spawns).toEqual([["consolidate"]]);
  });
});

describe("hook cwd-changed", () => {
  it("switches the session's project namespace", async () => {
    t.openDb().close();
    const otherCwd = join(t.root, "other-project");
    mkdirSync(otherCwd, { recursive: true });

    await t.run("cwd-changed", { session_id: "sess-1", cwd: otherCwd });

    const db = t.openDb();
    try {
      const row = db
        .prepare("SELECT project_id FROM sessions WHERE session_id = ?")
        .get("sess-1") as { project_id: string };
      expect(row.project_id).toBe(resolveProjectId(otherCwd));
      expect(row.project_id).not.toBe(t.projectId);
    } finally {
      db.close();
    }
  });
});
