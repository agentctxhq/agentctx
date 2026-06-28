# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

`@agentctxhq/agentctx` is a context layer for Claude Code. It integrates via two surfaces:

1. **MCP server** — exposes tools Claude can call to query project context, architecture decisions, codebase topology, and developer preferences
2. **Hook layer** — installs Claude Code hooks for budgeted context injection (SessionStart, UserPromptSubmit), observation capture (PostToolUse), and async LLM extraction + consolidation at session end (Stop, SessionEnd)

The core distinction: this is a **context** tool, not a memory tool. Context is structured understanding of what is being built; memory is a log of what happened.

The v0.1 milestone surface is implemented (v0.1.0): storage + FTS5 retrieval, hooks, LLM extraction, the MCP server, drift detection, and the full CLI. Current work targets v0.2 (semantic layer + web dashboard).

Documentation hierarchy — consult before making design-level changes:
- **docs/VISION.md** — why the project exists and its scope boundaries (the "What agentctx Is Not" list is binding)
- **docs/SPEC.md** — normative contracts: record types, schema, hook behavior, MCP tool signatures, token budgets. Source of truth in implementation debates
- **docs/ARCHITECTURE.md** — all architecture decisions (ADR-style) and their rationale
- **docs/ROADMAP.md** — the milestone plan
- **CHANGELOG.md** — release notes; update when shipping a new version

Contract changes (record types, tool signatures, budgets) require updating SPEC.md and the relevant ADR in the same PR.

**Target: Claude Code only.** No plans for Cursor or other agents.

## Architecture

The repo is an npm-workspaces monorepo. The CLI package lives in `packages/agentctx` (TypeScript, ESM): source in `src/`, compiled output in `dist/`, with `dist/cli.js` exposed as the `agentctx` binary via `package.json#bin`. The web dashboard (`@agentctxhq/agentctx-ui`, v0.2) will be a sibling package under `packages/`. The only runtime dependency is `better-sqlite3` — the v0.1 rule (zero runtime dependencies beyond it) holds and every addition must be justified against an ADR.

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

Run from the repo root (npm workspaces):

```bash
npm ci            # install dev dependencies (Node ≥ 20)
npm run build     # tsc → packages/agentctx/dist
npm run test      # vitest, all packages
npm run typecheck # tsc --noEmit
npm run lint      # biome check (lint + format)
npm run check     # local full gate: lint + typecheck + build + test
node packages/agentctx/dist/cli.js   # run the CLI after building
```

Run a single test file: `npx vitest run test/cli.test.ts` from `packages/agentctx`.

## Conventions

- **Commits**: Use [Conventional Commits](https://www.conventionalcommits.org) — `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`
- **PRs**: One logical change per PR; open an issue first for significant changes
- **License**: Elastic License 2.0 (contributors grant perpetual irrevocable license per CONTRIBUTING.md)
- **AI-generated code**: Allowed, but contributors must understand and be able to defend every line submitted
