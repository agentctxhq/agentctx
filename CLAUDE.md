# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@agentctxhq/agentctx` is a local MCP (Model Context Protocol) server that maintains structured project context across AI coding agent sessions. It stores context in `~/.agentctx/` on disk — no cloud, no API key.

The core distinction: this is a **context** tool, not a memory tool. Context is structured understanding of what is being built; memory is a log of what happened.

This project is in early pre-alpha (v0.0.1). The current codebase is a placeholder CLI stub. Active development targets:
- `v0.1` — MCP server, local SQLite storage, Claude Code integration
- `v0.2` — Cursor integration, context viewer

## Architecture

The project is a Node.js CLI package. Entry point is `index.js`, exposed as the `agentctx` binary via `package.json#bin`. There are no dependencies yet.

When the MCP server is implemented, it will:
- Run locally on the developer's machine
- Persist context to `~/.agentctx/` using SQLite
- Integrate with Claude Code first, then Cursor

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
