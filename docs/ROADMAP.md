# agentctx Roadmap

agentctx is a context layer for Claude Code: structured, persistent, searchable understanding of what you are building — not a log of what happened. This document describes what we ship and in what order. The problem and scope boundaries live in [VISION.md](./VISION.md), the normative contracts in [SPEC.md](./SPEC.md), and the architectural reasoning in [ARCHITECTURE.md](./ARCHITECTURE.md).

---

## The Three Core Pain Points

These are the problems this project exists to solve:

1. **CLAUDE.md goes stale.** Architectural decisions made last month aren't in it. Conventions discovered last week aren't in it. Nobody updates it. Claude operates on an outdated map.

2. **Session switches lose everything.** A new session — whether it's the next morning or switching to a different branch — restarts from zero. Everything re-explained, every convention re-established, every decision re-made.

3. **Projects and developers have no shared identity across time.** The way you work (your style, your process preferences) isn't captured anywhere. And when you switch between projects, nothing carries over from one to the next.

## Why LLM Enrichment Must Be On By Default

A purely deterministic context layer — one that only captures what you explicitly tell it — won't solve these problems in practice. Developers don't make `ctx_record` calls. The important decisions happen inside conversations, not as explicit commands.

The concern about LLM cost is resolved by the numbers: using Claude Haiku 4.5 for session-end extraction costs approximately **$0.015 per session** and roughly **$0.60/month** for a developer doing two sessions per day. This is not a real cost. Extraction runs out-of-band, asynchronously, after the session ends — it has zero impact on session latency.

What's expensive is wasted context window space. Our hard token budget contract (≤1,500 tokens at session start, per-turn injection deduped and capped) is more important for user economics than the $0.015 extraction call.

---

## Milestones

Each milestone ships something independently useful.

---

### v0.1 — Foundation: capture, store, inject

*This is the complete working tool. Every later milestone improves it.*

**What it delivers:**
- A new session begins knowing your active task, recent architectural decisions, and where you left off — without re-explaining
- CLAUDE.md staleness is detected and surfaced automatically
- Developer preferences accumulate across projects over time

#### Storage

- `better-sqlite3` as the SQLite driver (ships bundled SQLite with FTS5 compiled in — critical; `node:sqlite` in Node 24 lacks FTS5)
- Single SQLite database: `~/.agentctx/agentctx.db`, WAL mode
- `sqlite-vec` extension via platform prebuilt binaries (optionalDependencies)
- Bi-temporal record schema with seven types: `decision`, `convention`, `preference`, `discovery`, `bugfix`, `handover`, `profile`
- Graph adjacency tables (`nodes` + `edges`, indexed) for relationship traversal
- FTS5 virtual table over `records` — the real-time retrieval engine
- Per-project namespace (git remote hash → path hash fallback)
- Global developer profile namespace at `~/.agentctx/profile/` — preferences that transcend projects

#### Hook layer

- `agentctx init` — explicit one-command setup: creates `~/.agentctx/`, registers MCP server, writes hooks into `~/.claude/settings.json` via PATH-resolved commands (version-stable, never break on upgrade)
- `agentctx uninstall` — removes everything, no residue
- **SessionStart** — reads pre-computed digest file, returns ≤1,500-token injection: project profile + active decisions + last handover + global developer preferences + MCP index hint
- **UserPromptSubmit** — FTS5 BM25 search on the actual user prompt; session-scoped dedup (per-session `/tmp` file); inject top-3 fresh records ≤2,000 tokens; re-runs on session resume correctly
- **Stop** — spawns detached `agentctx extract` subprocess (async, no hook latency)
- **PreCompact** — snapshots working state before compaction fires and destroys it
- **PostToolUse** (async) — lightweight structured observation capture; never blocks the loop
- **SessionEnd** — runs consolidation pass + pre-computes next SessionStart digest
- **CwdChanged** — switches active project namespace

#### LLM extraction pipeline

- Haiku 4.5, out-of-band at session end
- Output schema: decisions (what + rationale + supersedes + confidence), preferences (category + rule + confidence + scope), conventions, active_work (task + blockers + next_steps), gotchas
- `confidence: "explicit" | "inferred"` discriminator — inferred facts start with lower score, require reinforcement across sessions
- `scope: "project" | "global"` on preferences — global preferences feed the developer profile store
- `flush_ok` sentinel — trivial sessions write nothing
- Prompt caching on the system prompt (~80% reduction on repeated daily calls)
- Long transcript handling: first 3K + last 17K tokens for 15–50K transcripts; Map-Reduce above 50K
- Graceful degradation: if no API key (OQ-2), fall back to deterministic capture only

#### MCP server

Seven tools via stdio, registered at user scope:
- `ctx_search(query, type?, file?, scope?)` — FTS5 + recency → compact index (≤50 tokens/result)
- `ctx_get(ids[])` — full records by ID (progressive disclosure)
- `ctx_record(type, title, body, supersedes?, scope?)` — explicit capture
- `ctx_supersede(old_id, new_body, rationale)` — versioning
- `ctx_project()` — project profile and metadata
- `ctx_related(file)` — entity-linked records for a file
- `ctx_sync_claudemd()` — proposed CLAUDE.md additions and updates

#### CLAUDE.md staleness detection

- After each extraction, compare extracted decisions and conventions against CLAUDE.md content via FTS5 similarity
- When ≥2 drift candidates: include a one-line note in the SessionStart digest
- `agentctx sync` — generate a proposed CLAUDE.md diff for user review (never auto-applies)
- `ctx_sync_claudemd()` MCP tool for interactive review with Claude

#### CLI

- `agentctx init` / `agentctx uninstall`
- `agentctx status` — project context summary, cumulative injection token cost (we measure what we impose), extraction cost to date
- `agentctx search <query>` — FTS5 search from the terminal
- `agentctx show <id>` — full record display
- `agentctx export` — render full context store as Markdown
- `agentctx sync` — CLAUDE.md diff review
- `agentctx profile show` / `agentctx profile edit <id>` — manage global developer preferences
- `agentctx reset` — clear project context (with confirmation)
- `agentctx config` — set `--no-llm`, `--no-embeddings`, model tier, etc.

---

### v0.2 — Semantic layer + web dashboard

*Adds the ability to find context by meaning, not just keywords. Adds a visual interface.*

#### Semantic retrieval (offline)

- Full offline consolidation with embeddings: `bge-small-en-v1.5` q8 via `@huggingface/transformers` v4 (~34 MB, lazy-downloaded, fully offline afterward)
- Embedding backfill batch at `SessionEnd` (one model load, all `pending_embedding` records)
- Near-duplicate detection via cosine similarity within types — merge candidates surfaced for confirmation
- Access-weighted + recency decay scoring: `score = relevance × access_decay × recency_decay × confidence_weight`
- The pre-computed SessionStart digest now uses hybrid RRF ranking (FTS5 rank + vector rank, k=60) + recency + type weights, replacing the simpler recency-only ranking from v0.1
- Four-step degradation ladder: hybrid RRF → JS-cosine fallback → FTS5 keyword-only (`degraded` field) → LIKE

#### Web dashboard — `@agentctxhq/agentctx-ui`

- `agentctx ui` — checks for UI package, prompts if missing, starts Hono server on localhost:7327, opens browser
- **Stack:** Hono (`@hono/node-server`) + pre-built Preact SPA + `force-graph` (vasturiano, ~45kB, Canvas) for relationship graph
- **Security:** bind to 127.0.0.1, Host header validation (DNS rebinding protection), `Sec-Fetch-Site` check (CSRF), startup secret token
- **Views:** Projects overview, Records browser (searchable + filterable), Graph visualization (decisions + supersession chains + entity links), Developer Profile, Session history with cost tracking, CLAUDE.md sync diff

---

### v0.3 — Lifecycle maturity + team depth

*The store stays correct over months. Team members share architectural knowledge.*

#### Context lifecycle

- Supersession UX: full `agentctx supersede <id>` workflow, rule-based supersession for keyed types
- History queries: `ctx_search(as_of: "2026-03-01")` — what was true on a given date
- Worktree support: `WorktreeCreate` hook inherits project context into new worktree; per-worktree handover scoping (OQ-3)
- Subagent injection: `SubagentStart` hook injects task-relevant context into Claude Code subagents (matcher-scoped, same token budget discipline)
- Confidence lifecycle: inferred preferences upgrade to `reinforced` after N cross-session appearances; reinforced preferences get stronger SessionStart priority

#### Team context

- `.agentctx/context.md` in the repo — git-committable, line-oriented (one record per block, tractable merge conflicts), PR-diffable
- Import on SessionStart: teammates' committed decisions and conventions load into local retrieval automatically; no manual sync step
- `agentctx promote <id>` — explicit personal→team promotion, never automatic (privacy by default)
- Round-trip: hand-edits to the team file import cleanly back into the store
- Onboarding: a new developer clones the repo and their first session has the project's full decision history

#### Distribution

- Claude Code plugin packaging as a second channel (hooks + MCP bundled): `claude plugin install agentctx`
- Plugin is a thin wrapper over the CLI; CLI remains primary and standalone

---

### v0.4 — Developer experience + trust

*Proof the system works. Measure the tax. Tune from real data.*

- Reproducible public eval: seeded repository + scripted multi-session tasks + extraction quality scoring. No competitor publishes one. Self-reported benchmarks are the norm we break from.
- Token impact reporting: per-session and cumulative injection cost; digest hit-rate (how often injected context was followed up with a `ctx_get` — a signal that it was actually relevant)
- Extraction quality review: `agentctx review-session <id>` — show what was extracted from a session and let the developer correct misattributions
- Tuning from real usage: decay half-lives, RRF weights, confidence upgrade thresholds, session budget allocation
- Hardening: OQ-1 (better-sqlite3 Node compatibility matrix), OQ-2 (API key detection + graceful degradation), Windows support verification

---

### v0.5 — Cloud sync and team plans

*Context that follows you and your team across machines. The foundation for a paid tier.*

- Cross-machine personal sync: file-based, user-controlled, no cloud service required as a baseline
- Team sync: encrypted sync of `.agentctx/context.md` equivalent across team members, conflict resolution via the same bi-temporal supersession model
- The web dashboard API (built in v0.2) gets an authentication layer and a remote-storage backend; the frontend doesn't change
- Foundation for a paid hosted tier: organization-level context, analytics, admin controls
- OQ-5: sync protocol, conflict resolution, and auth model decided and documented

---

## Success Criteria

| Metric | Target | Comparison |
|---|---|---|
| Session-start injection | ≤1,500 tokens, always | Category leader ~40% of window |
| Install | One command, no compiler, no daemon | Works offline after 34 MB optional download |
| Session continuity | New session knows active task + recent decisions | Without re-explaining |
| CLAUDE.md currency | Drift detected, sync proposed automatically | Stale files are the status quo |
| Correctness | Superseded facts never surface in default retrieval | Every naive accumulator fails this |
| Extraction cost | ~$0.015/session, reported in `agentctx status` | Transparent, not hidden |

## Non-Goals

These are the headline exclusions; [VISION.md](./VISION.md) is the authoritative list and explains the reasoning behind each.

- Other agents (Cursor, Codex, etc.) — Claude Code-native depth is the differentiator
- Replacing Claude Code's native memory, CLAUDE.md, or skills — we sit beneath them
- An always-on background process or daemon — ever
- ANN indexes, graph databases, or a second storage system
- Automatic writes to any user-controlled file (CLAUDE.md, .gitignore, etc.) without confirmation
