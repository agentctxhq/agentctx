#!/usr/bin/env node
/**
 * Bin entry. Kept import-free on purpose: `agentctx hook <event>` is
 * Claude Code's hook command, and it must exit 0 silently even when the
 * install is broken (missing deps, failed native build) — a half-installed
 * agentctx must never break a Claude Code session (issue 2/7). Everything
 * else loads lazily via cli/main.js.
 */
const argv = process.argv.slice(2);

if (argv[0] === "hook") {
  // Dispatcher stub: every event exits 0 with no output. Real hook
  // behavior lands in issue 3/7.
  process.exit(0);
}

import("./cli/main.js")
  .then((m) => m.main(argv))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`agentctx: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
