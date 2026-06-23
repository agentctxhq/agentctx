#!/usr/bin/env node
/**
 * Bin entry. Kept import-free on purpose: `agentctx hook <event>` is
 * Claude Code's hook command, and it must exit 0 silently even when the
 * install is broken (missing deps, failed native build) — a half-installed
 * agentctx must never break a Claude Code session (issue 2/7). The hook
 * dispatcher and everything else load lazily.
 */
import { describeError } from "./errors.js";

const argv = process.argv.slice(2);

if (argv[0] === "hook") {
  // Hooks never error into the session (SPEC §8 rung 5): if even the
  // dispatcher import fails, swallow it and exit 0 with no output.
  import("./hooks/runner.js")
    .then((m) => m.runHook(argv[1]))
    .catch(() => {})
    .then(() => {
      process.exitCode = 0;
    });
} else {
  import("./cli/main.js")
    .then((m) => m.main(argv))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`agentctx: ${describeError(error)}`);
      process.exitCode = 1;
    });
}
