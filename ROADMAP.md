# agentctx Roadmap

agentctx is a context layer for Claude Code: a structured, persistent, searchable model of what you are building — not a log of what happened. This document describes what we are building and in what order. The technical reasoning behind these choices lives in [ARCHITECTURE.md](./ARCHITECTURE.md); read that first if you want the *why*.

---

## The Problem

Every Claude Code session starts amnesiac. You re-explain architecture, repeat conventions, re-describe where you left off; Claude re-infers your stack every morning; the decision you made last Tuesday is invisible today; and when autocompact fires, working state is destroyed without ceremony.

The existing fixes are memory tools — they log what happened and replay it. The best of them suffer from documented, recurring failure modes: session-start injection consuming 40% of the context window, background daemons that leak and crash, LLM compression that silently burns your Claude quota, and stores that accumulate stale facts until retrieval confidently returns the wrong answer.

## The Approach

A context layer with five non-negotiables (each is an ADR in ARCHITECTURE.md):

1. **Hard token budgets** — session-start injection is capped at 1,500 tokens in code; everything deeper is on-demand via MCP progressive disclosure
2. **No infrastructure** — no daemon, no Docker, no sidecar DB; hook-invoked CLI + one SQLite file
3. **No LLM in the default pipeline** — deterministic capture and retrieval; zero hidden API cost
4. **Bi-temporal facts** — decisions get superseded, never silently stale ("what do we use?" and "what did we use in March?" both answerable)
5. **Inspectable** — export everything to Markdown; team context lives in git as diffable text

And one positioning rule: agentctx sits **beneath** Claude Code's native memory (MEMORY.md / Auto Dream), as the deep, structured, searchable, team-shareable store — it does not compete with the 200-line hot working set.

---

## Milestones

Each milestone ships something independently useful. Keyword search before embeddings; capture before adaptation; single-player before team.

### v0.1 — Foundation: capture, store, retrieve (keyword-only)

*Independently useful as: session continuity + searchable decision log, zero model download.*

**Storage core**
- Single SQLite database (`~/.agentctx/agentctx.db`), WAL mode, via `node:sqlite` (Node ≥ 24)
- Bi-temporal record schema with the seven record types (`decision`, `convention`, `preference`, `discovery`, `bugfix`, `handover`, `profile`)
- FTS5 keyword search with recency/type reranking — the retrieval floor that everything later builds on
- Per-project namespacing keyed by git remote (path-hash fallback)

**Hook layer**
- `agentctx init` / `agentctx uninstall`: explicit, reversible, version-stable installation (hooks call `agentctx hook <event>` via PATH — never versioned paths)
- `SessionStart`: inject the budgeted digest (≤ 1,500 tokens, hard-capped; truncate, never overflow)
- `Stop`: write the session handover record (active task, decisions made, files touched, next steps) — parses the transcript JSONL via `transcript_path`
- `PreCompact`: snapshot working state before compaction destroys it
- `SessionEnd`: flush + pre-compute the next session's digest (keeps `SessionStart` instant)
- All capture hooks registered `async: true` — never block the agentic loop

**MCP server (stdio, user-scope registration)**
- The six-tool surface: `ctx_search`, `ctx_get`, `ctx_record`, `ctx_supersede`, `ctx_project`, `ctx_related`
- Progressive disclosure contract from day one: search returns a compact index (~50 tokens/result); full records only by explicit `ctx_get`

**Capture pipeline (deterministic)**
- Typed extraction from hook payloads; SHA-256 dedup (5-minute window); privacy filter (secret-pattern scrubbing, path ignores)
- Project profile auto-detection: language, framework, test/build commands, package manager, entry points

**CLI**
- `agentctx status` (including cumulative injection-token accounting — we measure the tax we impose), `agentctx search`, `agentctx show <id>`, `agentctx export`, `agentctx reset`

### v0.2 — Semantic layer: hybrid retrieval

*Independently useful as: retrieval that finds "how do we handle auth errors" — not just exact keywords.*

- Local embeddings: `@huggingface/transformers` v4 + `bge-small-en-v1.5` q8 (~34 MB, 384 dims)
- Lazy model download with progress notice; eager option in `agentctx init`; `--no-embeddings` opt-out; fully offline after download
- `sqlite-vec` for exact brute-force vector search (no ANN — wrong tool below ~100k chunks), prebuilt platform binaries as optionalDependencies
- Hybrid fusion: FTS5 + vector via Reciprocal Rank Fusion (k=60) + recency decay + pinning, in one SQL query
- Embedding backfill in batch at `SessionEnd` (one model load per session, `pending_embedding` flag for crash safety)
- The full four-step degradation ladder shipped and tested: hybrid → JS-cosine fallback → keyword-only (`degraded` flag) → LIKE
- Entity extraction (deterministic): file paths, symbols, package names linked to records; `ctx_search(file=...)` filtering
- **Prototype OQ-1:** per-prompt retrieval via `UserPromptSubmit` — measure latency against the 30s budget before adopting

### v0.3 — Context lifecycle: supersession, consolidation, adaptation

*Independently useful as: a store that stays correct and lean over months of use.*

- Deterministic supersession UX: `ctx_supersede` flows, rule-based supersession for keyed types (new test command replaces old), history queries ("as of March")
- Consolidation pass at `SessionEnd` (time-boxed): access-strengthening + Ebbinghaus-style decay scoring, near-duplicate merging (same-type cosine threshold), archival of long-superseded records
- Developer preference learning: capture corrections (deterministic signals — repeated user edits to Claude's output patterns) into `preference` records; surface for confirmation, never silently apply
- `CwdChanged` project switching; `WorktreeCreate` context inheritance (resolve OQ-2: shared project store, per-worktree handovers)
- `SubagentStart` context injection (matcher-scoped, budgeted like SessionStart)
- Optional LLM enrichment mode (off by default, spend reported in `agentctx status`): handover narrative polish, semantic-conflict flagging for human confirmation
- Claude Code plugin packaging as a second distribution channel (CLI remains primary) — revisit of ADR-010's provisional

### v0.4 — Trust and measurement

*Independently useful as: proof, not promises.*

- Reproducible public eval: seeded repository + scripted multi-session tasks + retrieval-quality scoring (no competitor publishes one; self-reported benchmarks are the norm we break from)
- Token-impact reporting: per-session and cumulative injection cost, digest hit-rate (how often injected content was actually relevant — measurable via `ctx_get` follow-ups)
- Tuning from real data: digest composition, decay half-lives, RRF rerank weights
- Hardening: Windows support decision (OQ-3), linux-arm64/musl verification, settings.json edit robustness across Claude Code versions

### v0.5 — Team context

*Independently useful as: architectural knowledge that survives beyond any one developer's machine.*

- Team store: `.agentctx/context.md` in the repo — decisions, conventions, project profile as line-oriented, PR-diffable Markdown
- Import-on-SessionStart: teammates' committed decisions flow into local retrieval automatically
- `agentctx promote <id>`: explicit personal→team promotion (never automatic — privacy by default)
- Round-trip editing: hand-edits to the team file import cleanly back into the store
- Onboarding flow: a new developer clones the repo and gets the project's full decision history in their first session

### Later / exploratory

- MEMORY.md bridge (opt-in): suggest promotion of hot agentctx records into Claude Code's native 200-line working set (ADR-013)
- "Instant tier" embeddings: model2vec/potion static embeddings (~8 MB, near-zero cold start) if we accept owning a JS port
- Cross-machine personal sync (file-based, user-controlled — still no cloud service)
- Channels integration for pushing external context (CI results) into running sessions — research-preview dependent

---

## Success Criteria

- **Injection tax:** ≤ 1,500 tokens at session start, verified by self-accounting — against a category leader criticized for ~40% of the window
- **Install:** one command, no compiler, no daemon, works offline after optional 34 MB model download; `uninstall` leaves zero residue
- **Continuity:** new session knows the active task, recent decisions, and where you left off — without the user re-explaining
- **Correctness over time:** superseded facts never surface as current in default retrieval
- **Trust:** every stored byte is exportable, readable, and (for team context) diffable in a PR

## Non-Goals

- Other agents (Cursor, Codex, etc.) — Claude Code-native depth is the differentiator, not breadth
- Cloud sync, hosted service, accounts, API keys, telemetry
- Replacing Claude Code's native memory, CLAUDE.md, or skills — we sit beneath them
- LLM-dependent core pipeline — enrichment stays optional forever
- ANN indexes, graph databases, or any second storage system
- A web dashboard (the CLI + Markdown export *is* the UI)
