import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lastUserPrompt } from "../../src/hooks/pre-compact.js";
import { insertRecord, listRecords } from "../../src/storage/records.js";
import { type HookTestEnv, makeHookEnv } from "./helpers.js";

let t: HookTestEnv;

beforeEach(() => {
  t = makeHookEnv();
});

afterEach(() => {
  t.cleanup();
});

function writeTranscript(lines: unknown[]): string {
  const path = join(t.root, "transcript.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return path;
}

const userEntry = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const assistantEntry = () => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text: "doing it" }] },
});

describe("hook pre-compact", () => {
  it("snapshots the last user prompt into a handover record", async () => {
    t.openDb().close();
    const transcript = writeTranscript([
      userEntry("first ask"),
      assistantEntry(),
      userEntry("please fix the flaky auth test"),
      assistantEntry(),
    ]);

    await t.run("pre-compact", {
      session_id: "sess-1",
      transcript_path: transcript,
      cwd: t.cwd,
      trigger: "auto",
    });

    const db = t.openDb();
    try {
      const handovers = listRecords(db, t.projectId, { type: "handover" });
      expect(handovers).toHaveLength(1);
      expect(handovers[0]?.body).toContain("please fix the flaky auth test");
      expect(handovers[0]?.source).toBe("hook_observation");
      expect(handovers[0]?.confidence).toBe("inferred");
    } finally {
      db.close();
    }
  });

  it("supersedes the previous handover (one current per project)", async () => {
    const db = t.openDb();
    insertRecord(db, {
      projectId: t.projectId,
      type: "handover",
      title: "Old handover",
      body: "previous session state",
      source: "llm_extraction",
    });
    db.close();
    const transcript = writeTranscript([userEntry("new work in flight")]);

    await t.run("pre-compact", { session_id: "s", transcript_path: transcript, cwd: t.cwd });

    const check = t.openDb();
    try {
      const current = listRecords(check, t.projectId, { type: "handover" });
      expect(current).toHaveLength(1);
      expect(current[0]?.body).toContain("new work in flight");
    } finally {
      check.close();
    }
  });

  it("writes nothing when the transcript is missing or has no user prompt", async () => {
    t.openDb().close();
    await t.run("pre-compact", {
      session_id: "s",
      transcript_path: join(t.root, "missing.jsonl"),
      cwd: t.cwd,
    });
    const toolResultOnly = writeTranscript([
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      },
    ]);
    await t.run("pre-compact", { session_id: "s", transcript_path: toolResultOnly, cwd: t.cwd });

    const db = t.openDb();
    try {
      expect(listRecords(db, t.projectId, { type: "handover" })).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("caps the snapshot body at the record size limit", async () => {
    t.openDb().close();
    const transcript = writeTranscript([userEntry("y".repeat(10_000))]);
    await t.run("pre-compact", { session_id: "s", transcript_path: transcript, cwd: t.cwd });

    const db = t.openDb();
    try {
      const handover = listRecords(db, t.projectId, { type: "handover" })[0];
      expect(handover).toBeDefined();
      expect(handover?.body.length ?? 0).toBeLessThanOrEqual(2000);
    } finally {
      db.close();
    }
  });
});

describe("lastUserPrompt", () => {
  it("skips meta entries and tool results, scanning from the end", () => {
    const path = writeTranscript([
      userEntry("real prompt"),
      { type: "user", isMeta: true, message: { role: "user", content: "meta noise" } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "x" }] } },
    ]);
    expect(lastUserPrompt(path)).toBe("real prompt");
  });

  it("tolerates a partial first line from tail reads and corrupt lines", () => {
    const path = join(t.root, "t.jsonl");
    writeFileSync(
      path,
      `{"type":"user","mess\nnot json\n${JSON.stringify(userEntry("ok"))}`,
      "utf8",
    );
    expect(lastUserPrompt(path)).toBe("ok");
  });
});
