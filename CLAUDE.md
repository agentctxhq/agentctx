# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@agentctxhq/agentctx` is a context layer for Claude Code. It integrates via two surfaces:

1. **MCP server** — exposes tools Claude can call to query project context, architecture decisions, codebase topology, and developer preferences
2. **Hook layer** — installs Claude Code hooks for automatic context capture (SessionEnd), context injection (SessionStart), and enrichment (PreToolUse/PostToolUse)

The core distinction: this is a **context** tool, not a memory tool. Context is structured understanding of what is being built; memory is a log of what happened.

This project is in early pre-alpha (v0.0.1). The current codebase is a placeholder CLI stub. See ROADMAP.md for the milestone plan and ARCHITECTURE.md for all architecture decisions (ADR-style) — consult ARCHITECTURE.md before making design-level changes; it is the source of truth for technical direction.

**Target: Claude Code only.** No plans for Cursor or other agents.

## Architecture

The project is a Node.js CLI package. Entry point is `index.js`, exposed as the `agentctx` binary via `package.json#bin`. There are no dependencies yet.

Key constraints from ARCHITECTURE.md (do not violate without updating the ADRs):
- No daemon/background process — hooks invoke the CLI, which reads/writes SQLite and exits
- SQLite via `better-sqlite3` (ships FTS5; `node:sqlite` in Node 24 lacks FTS5), WAL mode; sqlite-vec for offline vector work
- FTS5 is the real-time retrieval floor; ONNX embeddings are offline-only (cold start is 2–15s — too slow for synchronous hooks)
- LLM extraction (Haiku 4.5) is ON by default at session end (~$0.015/session); runs as a detached subprocess, never blocks hooks
- SessionStart injection hard-capped at 1,500 tokens; UserPromptSubmit adds ≤2,000 tokens/turn via FTS5 search, session-deduped
- Deep retrieval via MCP progressive disclosure: ctx_search → ctx_get, never bulk-inject
- Bi-temporal records (`valid_from`/`superseded_at`) — facts are superseded, never silently overwritten
- No component on the critical install path may require a compiler

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
