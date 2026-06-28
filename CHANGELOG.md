# Changelog

All notable changes to `@agentctxhq/agentctx` are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/). Versions follow [Semantic Versioning](https://semver.org). Commits follow [Conventional Commits](https://www.conventionalcommits.org).

---

## [0.1.0] — 2026-06-12

The complete v0.1 milestone: storage, hooks, LLM extraction, MCP server, CLAUDE.md drift detection, and the full CLI. Every deliverable in the [v0.1 roadmap](./docs/ROADMAP.md) is shipped. The package is published as `@agentctxhq/agentctx@0.1.0` on npm.

### Added

#### Storage foundation

- SQLite database at `~/.agentctx/agentctx.db`, WAL mode, single runtime dependency (`better-sqlite3`)
- Seven record types: `decision`, `convention`, `preference`, `discovery`, `bugfix`, `handover`, `profile`
- Bi-temporal schema (`valid_from` / `superseded_at`) — facts are versioned, never silently overwritten (Invariant 3)
- Per-project namespace via SHA-256 of normalized git remote URL; path-hash fallback; reserved `_global` namespace for the developer profile
- Graph adjacency tables (`nodes` + `edges`) for entity-linked retrieval
- FTS5 BM25 search with recency/type/pinning rerank; LIKE fallback with a `degraded` marker when FTS5 is unavailable
- ULID generation, dependency-free

#### Hook layer

- `agentctx init` — one-command setup: creates `~/.agentctx/`, bootstraps the database, writes hooks and MCP server registration into `~/.claude/settings.json` (surgical edit, idempotent, preserves all existing keys), auto-detects project profile; no postinstall scripts
- `agentctx uninstall` — reverses every change init made, no residue
- **SessionStart** — reads pre-computed digest, injects ≤1,500 tokens: project profile + active decisions + last handover + reinforced global preferences + MCP index hint; handles resume correctly
- **UserPromptSubmit** — FTS5 BM25 search on the literal prompt, per-session dedup via `/tmp` file, injects top-3 fresh records ≤2,000 tokens; degrades gracefully on missing/corrupt dedup file
- **Stop** — spawns detached `agentctx extract` subprocess asynchronously; returns immediately, zero hook latency
- **SessionEnd** — runs `agentctx consolidate`, pre-computes next SessionStart digest asynchronously
- **PreCompact** — snapshots active handover candidate before compaction fires
- **PostToolUse** (async) — deterministic observation capture: file-write entity links, error-pattern `bugfix` stubs, test-run outcomes, git-op records; never calls an LLM
- **CwdChanged** — switches active project namespace
- All hooks swallow failures and exit 0 — a broken context store never interrupts a session

#### LLM extraction pipeline

- Haiku 4.5 via the Anthropic API, runs out-of-band at session end (~$0.015/session)
- Structured output schema: `decisions` (what + rationale + supersedes + confidence), `preferences` (category + rule + confidence + scope), `conventions`, `active_work` → `handover` record, `gotchas`
- `confidence: "explicit" | "inferred"` discriminator — inferred facts start with a lower score and require reinforcement
- `scope: "project" | "global"` on preferences — global preferences feed the developer profile store
- `flush_ok` sentinel for trivial sessions (nothing written)
- Prompt caching on the system prompt (~80% cost reduction on repeated daily calls)
- Long transcript handling: full for ≤15K tokens; first 3K + last 17K for 15–50K; Map-Reduce above 50K
- OQ-2 resolved: absent/empty `ANTHROPIC_API_KEY` → extraction exits 0 without touching the network; deterministic capture, digest, injection, and MCP remain fully functional

#### Consolidation pass

- Confidence lifecycle: `inferred → reinforced` after N cross-session re-appearances (configurable via `agentctx config`)
- Recency-based score update
- Pre-computes the next SessionStart digest file (recency-ranked, token-budget composed per SPEC §4)
- CLAUDE.md drift detection: FTS5 similarity comparison of active `decision`/`convention` records against CLAUDE.md content; `claudemd_drift_score` per record; one-line note in SessionStart digest when ≥2 candidates exceed the threshold

#### MCP server (seven tools via stdio)

Registered at user scope by `agentctx init`; runs as `agentctx mcp`.

- `ctx_search(query, type?, file?, scope?, limit?)` — FTS5 + recency rerank, compact index ≤50 tokens/result, ≤15 results, no bodies
- `ctx_get(ids[])` — full records including bi-temporal fields and provenance; increments `access_count` / `last_accessed`
- `ctx_record(type, title, body, supersedes?, scope?)` — explicit capture, `source = "mcp_tool"`, `confidence = "explicit"`
- `ctx_supersede(old_id, new_body, rationale)` — structured error if target is already superseded or cross-namespace
- `ctx_project()` — project profile, record counts by type, last session summary
- `ctx_related(file)` — entity-linked records for a given file path, compact-index format
- `ctx_sync_claudemd()` — drift report `{missing, contradicted, proposed_diff}` referencing record IDs

#### CLI surface

- `agentctx status` — project context summary, cumulative injection token cost, extraction cost to date; all-project totals and effective config
- `agentctx search <query>` — FTS5 terminal search through the same BM25 engine as every other path
- `agentctx show <id>` — full record pretty-print: provenance, confidence, bi-temporal fields, derived scores; superseded records refused by default with a pointer to the current head; `--history` enables explicit history inspection
- `agentctx export` — full context store as organized Markdown, grouped by type; `--out <file>` option; database remains the source of truth
- `agentctx profile show|edit|clear` — global developer preference management; `edit` supersedes with history preserved; `clear` hard-deletes with confirmation; mutations refresh `~/.agentctx/profile/preferences.md`
- `agentctx sync` — proposed CLAUDE.md diff for user review; applying is a confirmed explicit action, never automatic
- `agentctx config` — get/set `--no-llm`, `--no-embeddings`, model tier, reinforcement threshold N
- `agentctx reset` — clear current project's records (with confirmation)

#### Hardening

- Node 20/22/24 support matrix enforced at `init` (OQ-1 resolved); ABI-mismatch and missing-prebuild failures on unsupported Node versions are translated into actionable support-matrix guidance (`cli/node-support.ts`) instead of a stack trace; native code is never compiled on the install path
- End-to-end test (`test/e2e.test.ts`): init → hook invocations with fixture payloads → mocked Anthropic API extraction → consolidation → SessionStart digest correctness; both injection budgets asserted (≤1,500 / ≤2,000 tokens); session dedup verified; extraction cost lands on the session row
- Invariant audit: superseded records do not surface in any default path (hooks, MCP, CLI search/export/status); concurrent WAL writes verified safe; hooks exit 0 against missing and corrupt stores
- 287 tests across unit, integration, and end-to-end suites; CI runs lint plus the build/test matrix, while `npm run check` is the full local gate (lint + typecheck + build + test)

---

*Versions prior to 0.1.0 were pre-release development iterations with no published npm package.*
