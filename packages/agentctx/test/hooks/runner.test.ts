import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHook } from "../../src/hooks/runner.js";
import { type HookTestEnv, makeHookEnv } from "./helpers.js";

let t: HookTestEnv;

beforeEach(() => {
  t = makeHookEnv();
});

afterEach(() => {
  t.cleanup();
});

describe("runHook — hooks never error into the session (SPEC §8 rung 5)", () => {
  it("returns 0 for unknown or missing events without reading stdin", async () => {
    expect(await runHook("definitely-not-an-event", t.env)).toBe(0);
    expect(await runHook(undefined, t.env)).toBe(0);
    expect(t.emitted).toEqual([]);
    expect(t.logs).toEqual([]);
  });

  it("returns 0 on empty or invalid stdin payloads", async () => {
    t.setStdin("");
    expect(await runHook("session-start", t.env)).toBe(0);
    t.setStdin("not json at all");
    expect(await runHook("session-start", t.env)).toBe(0);
    t.setStdin('["an array, not an object"]');
    expect(await runHook("user-prompt-submit", t.env)).toBe(0);
    expect(t.emitted).toEqual([]);
  });

  it("swallows and logs handler failures, still returning 0", async () => {
    const env = {
      ...t.env,
      readStdin: async () => {
        throw new Error("stdin exploded");
      },
    };
    expect(await runHook("session-start", env)).toBe(0);
    expect(t.logs.join("\n")).toContain("stdin exploded");
  });

  it("handles every registered event arg with an empty-object payload", async () => {
    for (const event of [
      "session-start",
      "user-prompt-submit",
      "stop",
      "pre-compact",
      "post-tool-use",
      "session-end",
      "cwd-changed",
    ]) {
      expect(await t.run(event, { hook_event_name: event })).toBe(0);
    }
  });
});
