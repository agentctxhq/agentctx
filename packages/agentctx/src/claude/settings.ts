/**
 * Hook registration surgery on Claude Code settings files (ADR-016, SPEC §4).
 *
 * Edits are surgical: parse → strip only entries we own (commands invoking
 * `agentctx hook …`) → re-append ours → write back. Everything the user put
 * in the file — other hooks, other keys, matcher entries that mix our command
 * with theirs — is preserved verbatim. Install and remove are idempotent.
 */
import {
  type JsonObject,
  SettingsError,
  type SurgeryResult,
  isJsonObject,
  readJsonObject,
  writeJsonObject,
} from "./json-file.js";

/** The six hook events agentctx registers (SPEC §4). */
export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PreCompact",
  "PostToolUse",
  "SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** CLI argument form of an event: `SessionStart` → `session-start`. */
export function hookEventArg(event: HookEvent): string {
  return event.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * The command registered for an event. PATH-resolved, never a version-pinned
 * path (ADR-016) — upgrading the package must never break installed hooks.
 */
export function hookCommand(event: HookEvent): string {
  return `agentctx hook ${hookEventArg(event)}`;
}

/** Whether a hook command string is one of ours. */
export function isAgentctxHookCommand(command: unknown): boolean {
  return (
    typeof command === "string" &&
    (command === "agentctx hook" || command.startsWith("agentctx hook "))
  );
}

/**
 * Ensure every agentctx hook is registered in the settings file at `path`,
 * creating the file if needed. Idempotent: re-running against an installed
 * file is a no-op; partial installs are repaired.
 */
export function installHooks(path: string): SurgeryResult {
  const settings = readJsonObject(path) ?? {};
  const before = JSON.stringify(settings);

  const hooks = ensureHooksObject(settings, path);
  for (const event of HOOK_EVENTS) {
    const entries = ensureEventArray(hooks, event, path);
    const kept = withoutAgentctxCommands(entries);
    kept.push({ hooks: [{ type: "command", command: hookCommand(event) }] });
    hooks[event] = kept;
  }

  if (JSON.stringify(settings) === before) {
    return { changed: false };
  }
  writeJsonObject(path, settings);
  return { changed: true };
}

/**
 * Remove every agentctx hook from the settings file at `path`. Entries that
 * mix our command with user commands keep the user commands; event arrays
 * and the `hooks` object are deleted only when they end up empty.
 */
export function removeHooks(path: string): SurgeryResult {
  const settings = readJsonObject(path);
  if (settings === null || !("hooks" in settings)) {
    return { changed: false };
  }
  const before = JSON.stringify(settings);

  const hooks = ensureHooksObject(settings, path);
  for (const event of Object.keys(hooks)) {
    const entries = hooks[event];
    if (!Array.isArray(entries)) {
      continue;
    }
    const kept = withoutAgentctxCommands(entries);
    if (kept.length === 0) {
      delete hooks[event];
    } else {
      hooks[event] = kept;
    }
  }
  if (Object.keys(hooks).length === 0) {
    // biome-ignore lint/performance/noDelete: removing the key from the serialized file is the point
    delete settings.hooks;
  }

  if (JSON.stringify(settings) === before) {
    return { changed: false };
  }
  writeJsonObject(path, settings);
  return { changed: true };
}

function ensureHooksObject(settings: JsonObject, path: string): JsonObject {
  const existing = settings.hooks;
  if (existing === undefined) {
    const hooks: JsonObject = {};
    settings.hooks = hooks;
    return hooks;
  }
  if (!isJsonObject(existing)) {
    throw new SettingsError(
      "unexpected_shape",
      path,
      `${path} has a "hooks" key that is not an object — agentctx will not modify it`,
    );
  }
  return existing;
}

function ensureEventArray(hooks: JsonObject, event: HookEvent, path: string): unknown[] {
  const existing = hooks[event];
  if (existing === undefined) {
    return [];
  }
  if (!Array.isArray(existing)) {
    throw new SettingsError(
      "unexpected_shape",
      path,
      `${path} has a "hooks.${event}" key that is not an array — agentctx will not modify it`,
    );
  }
  return existing;
}

/**
 * Strip agentctx commands out of a hook entry list, preserving everything
 * else: foreign entries verbatim, and user commands inside mixed entries.
 */
function withoutAgentctxCommands(entries: unknown[]): unknown[] {
  const kept: unknown[] = [];
  for (const entry of entries) {
    if (!isJsonObject(entry) || !Array.isArray(entry.hooks)) {
      kept.push(entry);
      continue;
    }
    const commands = entry.hooks.filter(
      (h) => !(isJsonObject(h) && isAgentctxHookCommand(h.command)),
    );
    if (commands.length === entry.hooks.length) {
      kept.push(entry);
    } else if (commands.length > 0) {
      kept.push({ ...entry, hooks: commands });
    }
    // ours-only entry → dropped
  }
  return kept;
}
