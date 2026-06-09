# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@agentctxhq/agentctx` is a context layer for Claude Code. It integrates via two surfaces:

1. **MCP server** — exposes tools Claude can call to query project context, architecture decisions, codebase topology, and developer preferences
2. **Hook layer** — installs Claude Code hooks for automatic context capture (SessionEnd), context injection (SessionStart), and enrichment (PreToolUse/PostToolUse)

The core distinction: this is a **context** tool, not a memory tool. Context is structured understanding of what is being built; memory is a log of what happened.

This project is in early pre-alpha (v0.0.1). The current codebase is a placeholder CLI stub. See ROADMAP.md for the full plan.

**Target: Claude Code only.** No plans for Cursor or other agents.

## Architecture

The project is a Node.js CLI package. Entry point is `index.js`, exposed as the `agentctx` binary via `package.json#bin`. There are no dependencies yet.

When implemented, agentctx will:
- Run locally on the developer's machine
- Persist context to `~/.agentctx/` using SQLite (no cloud, no API key)
- Register as an MCP server that Claude Code connects to
- Install hooks into `.claude/settings.json`

## Commands

No build, test, or lint scripts are configured yet. To run the CLI locally:

```bash
node index.js
# or after npm install -g:
agentctx
```

## Conventions

- **Commits**: Use [Conventional Commits](https://www.conventionalcommits.org) — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`
- **PRs**: One logical change per PR; open an issue first for significant changes
- **License**: Elastic License 2.0 (contributors grant perpetual irrevocable license per CONTRIBUTING.md)
- **AI-generated code**: Allowed, but contributors must understand and be able to defend every line submitted
