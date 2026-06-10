import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsError } from "../../src/claude/json-file.js";
import {
  HOOK_EVENTS,
  hookCommand,
  hookEventArg,
  installHooks,
  removeHooks,
} from "../../src/claude/settings.js";

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentctx-settings-"));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  settingsPath = join(dir, ".claude", "settings.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(settingsPath, "utf8"));
}

function write(value: unknown): void {
  writeFileSync(settingsPath, JSON.stringify(value, null, 2), { encoding: "utf8" });
}

function eventEntries(settings: Record<string, unknown>, event: string): unknown[] {
  const hooks = settings.hooks as Record<string, unknown[]>;
  return hooks[event] ?? [];
}

describe("hookEventArg / hookCommand", () => {
  it("maps event names to kebab-case PATH-resolved commands", () => {
    expect(hookEventArg("SessionStart")).toBe("session-start");
    expect(hookEventArg("UserPromptSubmit")).toBe("user-prompt-submit");
    expect(hookEventArg("PostToolUse")).toBe("post-tool-use");
    expect(hookCommand("Stop")).toBe("agentctx hook stop");
    // ADR-016: never a version-pinned path
    for (const event of HOOK_EVENTS) {
      expect(hookCommand(event)).not.toMatch(/[/\\]/);
    }
  });
});

describe("installHooks", () => {
  it("creates the settings file with all six hook events", () => {
    const result = installHooks(settingsPath);
    expect(result.changed).toBe(true);

    const settings = read();
    for (const event of HOOK_EVENTS) {
      const entries = eventEntries(settings, event);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        hooks: [{ type: "command", command: hookCommand(event) }],
      });
    }
  });

  it("is idempotent — re-running changes nothing", () => {
    installHooks(settingsPath);
    const first = readFileSync(settingsPath, "utf8");

    const second = installHooks(settingsPath);
    expect(second.changed).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(first);
  });

  it("preserves unrelated keys and foreign hook entries", () => {
    write({
      model: "opus",
      permissions: { allow: ["Bash(npm run test)"] },
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "other-tool start" }] }],
        Notification: [{ hooks: [{ type: "command", command: "notify-send hi" }] }],
      },
    });

    installHooks(settingsPath);
    const settings = read();

    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual({ allow: ["Bash(npm run test)"] });
    expect(eventEntries(settings, "Notification")).toEqual([
      { hooks: [{ type: "command", command: "notify-send hi" }] },
    ]);
    // foreign SessionStart entry kept, ours appended
    const sessionStart = eventEntries(settings, "SessionStart");
    expect(sessionStart).toHaveLength(2);
    expect(sessionStart[0]).toEqual({
      hooks: [{ type: "command", command: "other-tool start" }],
    });
  });

  it("repairs a partial install without duplicating existing entries", () => {
    installHooks(settingsPath);
    const settings = read();
    const hooks = settings.hooks as Record<string, unknown>;
    // JSON.stringify drops undefined-valued keys, so this writes a file without Stop.
    hooks.Stop = undefined;
    write(settings);

    const result = installHooks(settingsPath);
    expect(result.changed).toBe(true);
    for (const event of HOOK_EVENTS) {
      expect(eventEntries(read(), event)).toHaveLength(1);
    }
  });

  it("refuses to touch a file that is not valid JSON", () => {
    writeFileSync(settingsPath, "{ not json", { encoding: "utf8" });
    expect(() => installHooks(settingsPath)).toThrow(SettingsError);
    expect(readFileSync(settingsPath, "utf8")).toBe("{ not json");
  });

  it("refuses unexpected shapes instead of clobbering them", () => {
    write({ hooks: "not-an-object" });
    expect(() => installHooks(settingsPath)).toThrow(SettingsError);

    write({ hooks: { SessionStart: "not-an-array" } });
    expect(() => installHooks(settingsPath)).toThrow(SettingsError);
  });
});

describe("removeHooks", () => {
  it("returns unchanged when the file does not exist", () => {
    expect(removeHooks(settingsPath).changed).toBe(false);
  });

  it("removes exactly what install added — no residue", () => {
    write({ model: "opus" });
    const before = read();

    installHooks(settingsPath);
    const result = removeHooks(settingsPath);

    expect(result.changed).toBe(true);
    expect(read()).toEqual(before);
  });

  it("keeps user commands inside mixed entries", () => {
    write({
      hooks: {
        SessionStart: [
          {
            matcher: "startup",
            hooks: [
              { type: "command", command: "agentctx hook session-start" },
              { type: "command", command: "other-tool start" },
            ],
          },
        ],
      },
    });

    removeHooks(settingsPath);
    expect(eventEntries(read(), "SessionStart")).toEqual([
      { matcher: "startup", hooks: [{ type: "command", command: "other-tool start" }] },
    ]);
  });

  it("preserves foreign events and is idempotent", () => {
    write({
      hooks: {
        Notification: [{ hooks: [{ type: "command", command: "notify-send hi" }] }],
      },
    });
    installHooks(settingsPath);

    removeHooks(settingsPath);
    const after = readFileSync(settingsPath, "utf8");
    expect(eventEntries(read(), "Notification")).toHaveLength(1);

    expect(removeHooks(settingsPath).changed).toBe(false);
    expect(readFileSync(settingsPath, "utf8")).toBe(after);
  });
});
