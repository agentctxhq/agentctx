/**
 * Hook dispatcher: `agentctx hook <event>` lands here.
 *
 * The one inviolable rule (SPEC §8 rung 5): hooks never error into the
 * session. Every path — unknown event, empty stdin, handler exception —
 * resolves to exit code 0 with at most a line in the hook log. Anything a
 * handler wants the session to see goes through `env.emit` as structured
 * hook output, never stderr.
 */
import { type HookEnv, defaultHookEnv } from "./env.js";
import { runCwdChanged, runSessionEnd, runStop } from "./lifecycle.js";
import { type HookPayload, parseHookPayload } from "./payload.js";
import { runPostToolUse } from "./post-tool-use.js";
import { runPreCompact } from "./pre-compact.js";
import { runSessionStart } from "./session-start.js";
import { runUserPromptSubmit } from "./user-prompt-submit.js";

type HookHandler = (env: HookEnv, payload: HookPayload) => Promise<void>;

/**
 * The six registered events (SPEC §4) plus `cwd-changed` (ADR-001), which
 * is handled when invoked even though `agentctx init` does not register it.
 */
const HANDLERS: Record<string, HookHandler> = {
  "session-start": runSessionStart,
  "user-prompt-submit": runUserPromptSubmit,
  stop: runStop,
  "pre-compact": runPreCompact,
  "post-tool-use": runPostToolUse,
  "session-end": runSessionEnd,
  "cwd-changed": runCwdChanged,
};

/** Always resolves 0 — unknown events and all failures are swallowed. */
export async function runHook(
  event: string | undefined,
  env: HookEnv = defaultHookEnv(),
): Promise<number> {
  try {
    const handler = event === undefined ? undefined : HANDLERS[event];
    if (handler === undefined) {
      return 0;
    }
    const payload = parseHookPayload(await env.readStdin());
    if (payload === null) {
      return 0;
    }
    await handler(env, payload);
  } catch (error) {
    try {
      env.log(
        `hook ${event ?? "?"} failed: ${
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        }`,
      );
    } catch {
      /* even logging failures are swallowed */
    }
  }
  return 0;
}
