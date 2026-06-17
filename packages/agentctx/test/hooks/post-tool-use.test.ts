import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { responseText } from "../../src/hooks/post-tool-use.js";
import { listRecords } from "../../src/storage/records.js";
import { type HookTestEnv, makeHookEnv } from "./helpers.js";

let t: HookTestEnv;

beforeEach(() => {
  t = makeHookEnv();
  t.openDb().close(); // capture requires an existing database
});

afterEach(() => {
  t.cleanup();
});

function nodes(): Array<{ kind: string; name: string }> {
  const db = t.openDb();
  try {
    return db.prepare("SELECT kind, name FROM nodes ORDER BY name").all() as Array<{
      kind: string;
      name: string;
    }>;
  } finally {
    db.close();
  }
}

const bash = (command: string, response: unknown) => ({
  session_id: "sess-1",
  cwd: t.cwd,
  hook_event_name: "PostToolUse",
  tool_name: "Bash",
  tool_input: { command },
  tool_response: response,
});

describe("hook post-tool-use", () => {
  it("links file writes as file entities (absolute, cwd-resolved)", async () => {
    await t.run("post-tool-use", {
      cwd: t.cwd,
      tool_name: "Write",
      tool_input: { file_path: "src/app.ts", content: "..." },
    });
    expect(nodes()).toEqual([{ kind: "file", name: resolve(t.cwd, "src/app.ts") }]);
  });

  it("records git branch switches as branch entities", async () => {
    await t.run("post-tool-use", bash("git checkout -b feature/hooks", "Switched to a new branch"));
    await t.run("post-tool-use", bash("git switch main", "Switched to branch 'main'"));
    await t.run("post-tool-use", bash("git checkout -f release/v1", ""));
    await t.run("post-tool-use", bash("git switch --track origin/dev", ""));
    await t.run("post-tool-use", bash("git switch --detach feature-preview", ""));
    expect(nodes()).toEqual([
      { kind: "branch", name: "feature-preview" },
      { kind: "branch", name: "feature/hooks" },
      { kind: "branch", name: "main" },
      { kind: "branch", name: "origin/dev" },
      { kind: "branch", name: "release/v1" },
    ]);
  });

  it("does not mistake git pathspec separators for branch names", async () => {
    await t.run("post-tool-use", bash("git checkout -- src/app.ts", ""));
    expect(nodes()).toEqual([]);
  });

  it("captures a test failure as a deduplicated bugfix stub with a file entity link", async () => {
    const failure = {
      stdout: "FAIL test/auth.test.ts > login\nAssertionError: expected 401 to be 200",
      stderr: "",
    };
    await t.run("post-tool-use", bash("npx vitest run test/auth.test.ts", failure));
    // Same failing command again must not pile up another stub.
    await t.run("post-tool-use", bash("npx vitest run test/auth.test.ts", failure));

    const db = t.openDb();
    try {
      const stubs = listRecords(db, t.projectId, { type: "bugfix" });
      expect(stubs).toHaveLength(1);
      expect(stubs[0]?.title).toContain("Test failure: npx vitest run test/auth.test.ts");
      expect(stubs[0]?.source).toBe("hook_observation");
      expect(stubs[0]?.confidence).toBe("inferred");

      const links = db
        .prepare(
          `SELECT n.kind, n.name FROM record_entities re JOIN nodes n ON n.id = re.entity_id
           WHERE re.record_id = ?`,
        )
        .all(stubs[0]?.id) as Array<{ kind: string; name: string }>;
      expect(links).toEqual([{ kind: "file", name: resolve(t.cwd, "test/auth.test.ts") }]);

      const related = db
        .prepare(
          `SELECT re.record_id AS id FROM record_entities re JOIN nodes n ON n.id = re.entity_id
           WHERE n.kind = 'file' AND n.name = ?`,
        )
        .all(resolve(t.cwd, "test/auth.test.ts")) as Array<{ id: string }>;
      expect(related).toEqual([{ id: stubs[0]?.id }]);
    } finally {
      db.close();
    }
  });

  it("captures hard errors from non-test commands", async () => {
    await t.run(
      "post-tool-use",
      bash("node scripts/migrate.js", {
        stderr: "TypeError: Cannot read properties of undefined (reading 'id')",
      }),
    );
    const db = t.openDb();
    try {
      const stubs = listRecords(db, t.projectId, { type: "bugfix" });
      expect(stubs).toHaveLength(1);
      expect(stubs[0]?.title).toBe("Error observed: node scripts/migrate.js");
      expect(stubs[0]?.body).toContain("TypeError");
    } finally {
      db.close();
    }
  });

  it("records nothing for passing tests and clean commands", async () => {
    await t.run("post-tool-use", bash("npm test", { stdout: "Test Files  12 passed (12)" }));
    await t.run("post-tool-use", bash("ls -la", { stdout: "total 16\ndrwxr-xr-x ." }));
    const db = t.openDb();
    try {
      expect(listRecords(db, t.projectId, { type: "bugfix" })).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("never throws on malformed tool payloads", async () => {
    expect(await t.run("post-tool-use", { tool_name: "Bash", tool_input: { command: 42 } })).toBe(
      0,
    );
    expect(await t.run("post-tool-use", { tool_name: "Write", tool_input: {} })).toBe(0);
    expect(
      await t.run("post-tool-use", {
        tool_name: "Bash",
        tool_input: { command: "x" },
        tool_response: null,
      }),
    ).toBe(0);
    expect(t.logs).toEqual([]);
  });
});

describe("responseText", () => {
  it("flattens strings, objects, and garbage", () => {
    expect(responseText("plain")).toBe("plain");
    expect(responseText({ stdout: "out", stderr: "err" })).toBe("out\nerr");
    expect(responseText(null)).toBe("");
    expect(responseText(42)).toBe("");
    expect(responseText({ stdout: 7 })).toBe("");
  });
});
