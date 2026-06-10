#!/usr/bin/env node
import { VERSION } from "./index.js";

function main(argv: string[]): number {
  const [command] = argv;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    case "--version":
    case "-v":
      console.log(VERSION);
      return 0;
    default:
      console.error(`agentctx: unknown command "${command}" — pre-alpha, commands land with v0.1`);
      console.error("See https://github.com/agentctxhq/agentctx for the roadmap.");
      return 1;
  }
}

function printHelp(): void {
  console.log(`agentctx ${VERSION} — the context layer for Claude Code

Pre-alpha: the v0.1 command surface (init, status, search, sync, ...)
is under active development.

  https://agentctx.app
  https://github.com/agentctxhq/agentctx`);
}

process.exit(main(process.argv.slice(2)));
