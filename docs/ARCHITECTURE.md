# agentctx Architecture

This document records the architecture of agentctx — the decisions, the reasoning, and the trade-offs accepted. It is the source of truth for **why the system is shaped this way**. [VISION.md](./VISION.md) defines why the project exists and its scope boundaries; [SPEC.md](./SPEC.md) is the normative definition of the contracts themselves (data model, hook behavior, MCP tool surface, budgets); [ROADMAP.md](./ROADMAP.md) describes when things ship. When a contract detail here and in SPEC.md disagree, SPEC.md wins and this document gets a correcting PR.

Decisions are recorded ADR-style: context, decision, alternatives considered, trade-offs accepted. Statuses: **Accepted** (build this), **Provisional** (current best answer, revisit at the noted milestone), **Open** (not yet decided).

---

## 1. Design Philosophy

### Context, not memory

agentctx is a **context layer**, not a memory log. Every existing tool in this space (claude-mem, agentmemory, Mem0, mcp-memory-service, basic-memory) is fundamentally a log of what happened: session summaries, observations, conversation facts. agentctx maintains a structured model of *what is being built*: current architecture decisions with status, conventions, module topology, invariants, developer preferences — with explicit handling for facts that change over time.

### The five commitments

Each is a direct response to a documented failure mode in competing tools:

| Commitment | Failure mode it prevents | Documented where |
|---|---|---|
| **LLM enrichment on by default** | A purely deterministic store stays empty in practice; developers don't make explicit `record_decision` calls | Every tool that depends solely on explicit capture |
| **Hard token budgets, always** | Injection bloat — "40% of context consumed at session start" | claude-mem issues #618, #1848 |
| **No daemon, no sidecar** | Process leaks, crashes, port conflicts, fragile workers | claude-mem (Bun/Express + Chroma), XMem (Docker + 3 DBs) |
| **Facts can be superseded, never silently wrong** | Stale context — retrieval returns "we use REST" after the move to gRPC | Every naive accumulator |
| **Inspectable by humans** | Opaque vector-blob stores users can't audit or trust | Most vector-DB tools; basic-memory is praised for the opposite |

### Position relative to Claude Code's native memory

Claude Code ships Auto-Memory: a self-edited `MEMORY.md` (~200-line cap) plus an "Auto Dream" reorganization pass. agentctx is the structured, searchable, versioned layer **beneath** this — not a replacement for it:

- Native MEMORY.md = small, hot, prose working set (Letta's "memory block" idea, file-shaped). Claude Code manages it.
- agentctx = the deep store: thousands of typed, bi-temporal, entity-linked, hybrid-searchable records, plus team sharing and cross-machine portability that the native system lacks by design.

We never write to MEMORY.md uninvited.

---

## 2. System Overview

```
┌──────────────────────────── Claude Code ────────────────────────────────┐
│                                                                          │
│  SessionStart ─────► hook ──► pre-computed digest + global profile       │
│                              (≤1,500 tokens, hard-capped)                │
│                                                                          │
│  UserPromptSubmit ──► hook ──► FTS5 search on actual prompt              │
│                               (deduped per session, ≤2K tokens/turn)    │
│                                                                          │
│  Stop ──────────────► hook ──► async LLM extraction (Haiku 4.5)         │
│                               writes decisions / preferences / handover  │
│                                                                          │
│  PreCompact ────────► hook ──► snapshot working state before loss        │
│  PostToolUse ───────► hook ──► async typed observation capture           │
│  SessionEnd ────────► hook ──► offline consolidation + digest pre-compute│
│                                                                          │
│  MCP tools (deferred-loaded) ◄──► progressive disclosure                 │
│      ctx_search → compact index → ctx_get(ids) → full records            │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ hook-invoked CLI (no daemon)
                      ┌────────────┴────────────┐
                      │  ~/.agentctx/            │
                      │  agentctx.db (SQLite)    │
                      │  ├── records + edges     │  ← graph adjacency
                      │  ├── FTS5 virtual table  │  ← real-time retrieval
                      │  ├── sqlite-vec          │  ← offline consolidation
                      │  └── WAL mode            │  ← concurrent hooks
                      │                          │
                      │  ~/.agentctx/profile/    │  ← global developer prefs
                      │  ~/.agentctx/models/     │  ← embedding model cache
                      │  .agentctx/context.md    │  ← git-committable team export
                      └──────────────────────────┘
```

Two integration surfaces — the pattern every successful tool in this space converged on:

1. **Hooks** — automatic capture and injection at lifecycle events
2. **MCP** — on-demand deep retrieval (Claude decides when to dig)

Hooks-only tools inject indiscriminately. MCP-only tools depend on the model deciding to call them. Neither alone is sufficient.

---

## 3. Decisions

### ADR-001: Hooks + MCP dual-surface integration — **Accepted**

**Context.** Claude Code exposes both hooks (lifecycle events that execute scripts) and MCP (tools Claude can call). Pure-MCP tools suffer from passivity; pure-hook tools tax every session with undifferentiated context.

**Decision.** Use hooks for capture, minimal injection, and lifecycle management. Use MCP for on-demand retrieval.

| Hook | Role | Async? |
|---|---|---|
| `SessionStart` | Inject budgeted digest (pre-computed) + global profile | No — must return before session begins |
| `UserPromptSubmit` | FTS5 search on actual prompt → inject fresh records only | No — 30s budget, must return synchronously |
| `Stop` | Trigger async LLM extraction (background subprocess) | Yes — session already ending |
| `PreCompact` | Snapshot working state before compaction destroys it | No |
| `PostToolUse` | Capture typed observations from tool outputs | Yes — never block the loop |
| `SessionEnd` | Consolidation pass, pre-compute next SessionStart digest | Async — session is over |
| `CwdChanged` | Switch active project namespace | Yes |
| `SubagentStart` | Inject task-relevant context into subagents (v0.3) | Yes |

**Trade-offs.** `UserPromptSubmit` fires on every turn with a 30s timeout — this is synchronous. We mitigate this by using FTS5-only retrieval at query time (no ONNX model load — see ADR-006). Session resume replays `UserPromptSubmit` output from transcript rather than re-running the hook; therefore `SessionStart` is the reliable injection point for time-sensitive content (it re-runs on resume with `source: "resume"`).

**Rejected.** MCP-only (passivity), hooks-only (no on-demand depth), resident file-watcher daemon (that's a daemon — see ADR-002).

---

### ADR-002: No daemon. Hook-invoked CLI writes directly to SQLite — **Accepted**

**Context.** claude-mem runs a persistent Bun/Express worker on a per-user port plus Chroma. agentmemory pins an entire runtime engine (iii v0.11.2). XMem needs Docker. Infrastructure is the dominant fragility source in this category.

**Decision.** Every agentctx invocation is a short-lived process: a hook fires → the CLI runs → reads/writes SQLite → exits. SQLite WAL mode handles concurrent writers (parallel async hooks) safely. Background work (consolidation, LLM extraction) runs as a detached subprocess spawned from `SessionEnd`, not as a resident process.

**The cold-start question.** Node startup is ~50–100ms. For async hooks this is irrelevant; for the synchronous `SessionStart` and `UserPromptSubmit` hooks, it matters. `SessionStart` reads a pre-computed digest file (written at previous `SessionEnd`) — effectively instant. `UserPromptSubmit` runs FTS5 queries via SQLite — these resolve in 1–5ms after connection open. Total `UserPromptSubmit` latency: ~50–150ms, well within the 30s budget.

**Rejected.** Resident worker, lazy-spawned worker with idle timeout (still a daemon), or a persistent embedding server (just another daemon).

---

### ADR-003: SQLite via `better-sqlite3`; sqlite-vec for vectors — **Accepted** (revised from prior node:sqlite plan)

**Context.** An earlier draft planned to use Node's built-in `node:sqlite` to avoid native dependencies. This was reversed after confirming a critical upstream issue: `node:sqlite` in Node 24 is **not compiled with FTS5 support** (tracked in nodejs/node#56951). FTS5 is our retrieval floor — the system's most important query path. Without it, there is no graceful degradation.

`better-sqlite3` ships a bundled SQLite binary compiled with FTS5 enabled, has prebuilds for all major platforms (mac/linux/windows, x64/arm64), uses N-API (ABI-stable across Node versions), and is used by millions of npm packages. It is the correct choice.

**Decision.** `better-sqlite3` as the primary SQLite driver. `sqlite-vec` as a loadable extension for vector storage, delivered as prebuilt platform binaries via `optionalDependencies` (the esbuild/sharp distribution pattern).

**Design rule unchanged: no component on the critical install path may require a compiler.** `better-sqlite3` has prebuilds for current Node LTS. `sqlite-vec` has prebuilds for mac (arm64/x64), linux (x64), windows (x64). Verify linux-arm64 and musl coverage before v0.1 release; keep the JS cosine fallback (ADR-005) as the escape hatch.

**Rejected.**
- `node:sqlite` — lacks FTS5, the retrieval floor
- LanceDB — second storage system; strengths don't apply at our scale
- Chroma — external process, claude-mem's fragility source
- Graph databases (Kuzu: archived by Apple in October 2025; FalkorDB Lite: v0.3.0, 7 stars, Windows/macOS-x64 gaps) — see ADR-015

---

### ADR-004: SQLite is canonical; Markdown is a first-class export — **Accepted**

**Context.** basic-memory uses markdown files as source of truth and is praised for it: users can read and edit their AI's memory. But files-as-truth makes concurrent writes from hooks hard and couples the schema to a human-readable format.

**Decision.** The database is canonical. Inspectability is a product feature:
- `agentctx export` renders the full context store as organized Markdown
- `.agentctx/context.md` (per-project, git-committable) is a continuously maintained human-readable export of team-shareable context
- `agentctx show <id>` pretty-prints any record
- The DB is queryable with any SQLite client

**Trade-offs.** Users can't hand-edit the canonical store in a text editor directly. Mitigation: `agentctx edit <id>` for individual records; round-trip import of the team export for `.agentctx/context.md`.

---

### ADR-005: Hybrid retrieval — FTS5 for real-time; vectors for offline — **Accepted**

**Context.** Developer queries are keyword-shaped: error strings, function names, flags. BM25 catches `useAuthStore` where embeddings miss. Every serious agent memory system went hybrid (BM25 + vector). But there is a critical constraint (from ADR-006): ONNX model loading takes 2–15s per cold start — every hook invocation is a cold start with no daemon keeping the model warm. Embedding at query time in synchronous hooks is not viable.

**Decision.** Split vector and keyword work by latency tier:

**Real-time (synchronous hooks, UserPromptSubmit):** FTS5 BM25 only, with recency/type/pinning reranking. This is fast (~1–5ms), has zero model dependency, and degrades to LIKE-based search rather than failing hard. It is the reliable, always-available retrieval path.

**Offline (background consolidation at SessionEnd):** Full hybrid retrieval with vectors + RRF fusion for:
- Near-duplicate detection (same-type records with high cosine similarity)
- Decay scoring and clustering during the "dream" consolidation pass
- Pre-computing the ranked digest for the next SessionStart

The retrieval pipeline at query time:
1. FTS5 BM25 top-k on user prompt (records table via FTS5 virtual table)
2. Recency decay × type weight × pinning filter
3. Session-scoped dedup (exclude record IDs already injected this session)
4. Return top-3 records not previously injected

The offline vector pipeline (background, at SessionEnd):
1. Embed all `pending_embedding` records in batch (one model load, many records)
2. Run near-duplicate scan within each type: cosine > 0.92 → merge candidates
3. Update `score` field via access-weighted + recency decay formula
4. RRF over FTS5 rank + vector rank for the pre-computed SessionStart digest

**Brute-force, no ANN.** At our scale (hundreds to low tens-of-thousands of chunks per project), exact scan is single-digit ms. The industry crossover where ANN pays is ~100k vectors; sqlite-vec's stable releases are brute-force only anyway.

**Degradation ladder:**
1. FTS5 BM25 + recency reranking (default, real-time)
2. sqlite-vec unavailable: skip offline vector work; keyword-only remains functional
3. FTS5 unavailable (should not happen with better-sqlite3): LIKE-based search
4. All else fails: return pinned records only

---

### ADR-006: Local embeddings via transformers.js; offline-only use — **Accepted**

**Context.** The no-API-key constraint rules out cloud embeddings. Small ONNX models run locally are the field's converged answer. However: the ONNX runtime in transformers.js has a cold-start cost of 2–15s for JIT compilation on first load per process. With no daemon (ADR-002), every hook invocation is a new process and every embedding call is a cold start. This makes embedding at query time in synchronous hooks impossible.

**Decision.** Embeddings are **offline-only**: they run during the `SessionEnd` consolidation pass (a background subprocess with no latency constraint) and never in synchronous hooks.

- **Runtime:** `@huggingface/transformers` v4 (HF-maintained, ONNX, filesystem model cache, hard offline mode via `allowRemoteModels = false` after first download)
- **Default model:** `bge-small-en-v1.5` quantized q8 — ~34 MB, 384 dims. Superior retrieval quality to the all-MiniLM-L6-v2 that most competitors default to, at nearly identical size. Requires the query-side prefix; we own that detail internally.
- **Quality tier (opt-in config):** EmbeddingGemma-300m q4, dims truncated to 256 via Matryoshka — multilingual, better quality, slower
- **Download UX:** not bundled in the npm package. `agentctx init` offers eager download; otherwise first `SessionEnd` triggers it with a one-line notice ("Downloading embedding model (34 MB, one-time) → ~/.agentctx/models"). `--no-embeddings` opts out permanently; the tool remains fully functional on FTS5 only.
- **Pending embedding flag:** every new record has `pending_embedding = 1`. The consolidation pass embeds all pending records in one batch. Crash-safe: any unembedded records are just re-queued on next `SessionEnd`.

**Trade-offs.** Vectors are never used at query time for real-time injection. We accept this: FTS5 handles the query-shaped developer workload well, and the offline consolidation (decay scoring, near-duplicate merging, pre-computed digest ranking) is where vector similarity earns its value.

---

### ADR-007: Injection strategy — dual tier with hard budgets — **Accepted**

**Context.** There are two fundamentally different injection problems. The first is *what should Claude know at the start of a session* — this is answered by stable session-boundary context and is independent of any particular prompt. The second is *what is relevant to this specific question* — this is answered by searching against the user's actual prompt and changes turn-by-turn. These require different mechanisms.

**Decision.** Two injection tiers:

**Tier 1 — SessionStart (stable context, always-on):**
- Fires once per session (including on resume, with `source: "resume"` — this re-runs correctly)
- Content: project profile (~200t) + active decisions from the last session + last session handover + a one-line index of what's searchable via MCP + global developer profile preferences
- Hard cap: **1,500 tokens in code** — truncate from the bottom, never overflow
- Source: pre-computed digest written at the previous `SessionEnd`, so `SessionStart` reads a file and returns instantly
- Token composition: `<1,500t total` = project profile (~200t) + recent active decisions (~500t) + last handover (~400t) + MCP index hint (~100t) + developer profile (~200t)

**Tier 2 — UserPromptSubmit (query-aware, per-turn):**
- Fires on every user message (no matcher support — always fires)
- Uses FTS5 BM25 search against the actual user prompt (no ONNX — fast, no cold start)
- **Session-scoped dedup:** track injected record IDs in `/tmp/agentctx-<session_id>.json`; only inject records not already injected this session
- **Per-turn budget:** top-3 new records, ≤2,000 tokens total
- Total injection budget: **≤8,000 characters** (Claude Code's additionalContext limit)
- On session resume: `UserPromptSubmit` replays saved output from transcript (stale). This is acceptable because Tier 1 (SessionStart) carries the time-sensitive content and re-runs correctly.

**Self-accounting:** every injection includes its own token estimate in metadata. `agentctx status` reports cumulative injection cost per session. We measure the tax we impose.

**The 1,500-token rationale.** The correct trade is: a ~150-token tool call to fetch a specific record when needed costs far less than injecting 5,000 tokens of broad context on every session on the chance that some of it is relevant. The MCP progressive disclosure layer (ADR-008) is the complement to this discipline.

---

### ADR-008: MCP tool surface — minimal, progressive disclosure — **Accepted**

**Context.** MCP tool definitions consume context window space even with deferred loading. Tool sprawl — fifteen specialized tools — hurts attention and adds latency. One searchable store with typed records and a small progressive disclosure API beats many specialized tools.

**Decision.** Seven tools maximum in v0.1:

| Tool | Purpose |
|---|---|
| `ctx_search(query, type?, file?, scope?)` | FTS5 + recency search → compact index (~50 tokens/result, ≤15 results) |
| `ctx_get(ids[])` | Full records by ID — the progressive disclosure second step |
| `ctx_record(type, title, body, supersedes?, scope?)` | Record a decision, convention, or discovery explicitly |
| `ctx_supersede(old_id, new_body, rationale)` | Mark a fact as no longer current; create the replacing record |
| `ctx_project()` | Project profile: tech stack, commands, entry points |
| `ctx_related(file)` | Records linked to a file via entity associations |
| `ctx_sync_claudemd()` | Return proposed additions/updates to CLAUDE.md based on context store drift |

Progressive disclosure contract: `ctx_search` returns a compact index. Full content only via `ctx_get`. Claude drills down into what it actually needs.

---

### ADR-009: LLM enrichment is ON by default — **Accepted** (full reversal of prior position)

**Context.** A purely deterministic pipeline — SHA-256 dedup, typed extraction from hook payloads, explicit `ctx_record` MCP calls — has a fatal practical flaw: developers don't make explicit `ctx_record` calls. The context store stays mostly empty. Meaningful decisions ("we moved to gRPC," "always use arrow functions in this codebase") happen inside conversation, not as explicit commands. Without LLM extraction, agentctx solves the wrong problem.

The cost concern that motivated the prior "off by default" position was based on incorrect model pricing. Haiku 3.5 was retired February 19, 2026. The current cheap model is **Haiku 4.5** at **$1.00 input / $5.00 output per million tokens** — approximately **$0.015 per typical 10K-token session transcript, ~$0.60/month** for a developer doing two sessions per day. This is a non-cost.

**Decision.** LLM extraction runs by default at session end (Stop hook → background subprocess). Users can turn it off with `agentctx config --no-llm`; this degrades to deterministic capture only.

**Extraction pipeline:**

1. **Trigger:** Stop hook fires, spawns a detached subprocess (`agentctx extract --session-id $ID --transcript $PATH`) and returns immediately. No hook latency.
2. **Transcript handling:**
   - ≤15K tokens: single call, full transcript
   - 15K–50K tokens: first 3K tokens (project context, session setup) + last 17K tokens (current work state)
   - \>50K tokens: Map-Reduce — 10K-token chunks in parallel, merge with a second synthesis call
3. **Model:** Haiku 4.5 (quality sufficient for extraction; no frontier reasoning needed)
4. **Prompt caching:** system prompt (schema + examples + constraints) is prefixed with a cache breakpoint; after the first session in a day, system prompt reads cost 0.1× — saves ~80% of system prompt tokens.
5. **Output schema (structured JSON):**
   ```json
   {
     "decisions": [{"what": "...", "rationale": "...", "supersedes": null, "confidence": "explicit|inferred"}],
     "preferences": [{"category": "style|tooling|process|naming", "rule": "...", "confidence": "explicit|inferred", "scope": "project|global"}],
     "conventions": [{"scope": "file|module|project", "convention": "...", "confidence": "explicit|inferred"}],
     "active_work": {"current_task": "...", "blockers": [], "next_steps": [], "open_questions": []},
     "gotchas": [{"pattern": "...", "why_it_matters": "..."}],
     "flush_ok": false
   }
   ```
6. **FLUSH_OK sentinel:** when the session contains nothing worth persisting (a trivial exchange), the model returns `"flush_ok": true` and extraction writes nothing. Avoids polluting the store with noise.
7. **Confidence discriminator:** `"explicit"` (developer directly stated it) vs `"inferred"` (pattern observed across multiple choices). Inferred records start with a lower score and require reinforcement across sessions before reaching high confidence. Prevents hallucinated preferences from surfacing as hard facts.

**Extraction quality instructions (key prompt elements):**
- "Extract ONLY from things the developer said or chose, not from Claude's suggestions."
- "Do NOT extract: commands Claude ran autonomously, file contents Claude wrote unprompted, routine acknowledgments."
- "One entry per distinct fact. Do not merge separate decisions into one."
- "If nothing fits a category, return an empty array — do not invent entries."
- One concrete few-shot example per output field type.

**Failure modes and mitigations:**
- *Over-extraction* (most common): mitigated by the explicit negative examples, FLUSH_OK, and confidence scoring
- *Hallucination* (less common for extraction): mitigated by `confidence: "inferred"` tier, bi-temporal records (wrong facts get superseded)
- *Missing implicit decisions*: mitigated by asking for inferred entries explicitly when the pattern is clear

---

### ADR-010: Developer profile — global cross-project store — **Accepted**

**Context.** The user identified a key pain point: some context is not project-specific but developer-specific — coding style, process preferences, ways of working. "Always prefers arrow functions" or "writes tests before implementation" applies across every project this developer touches. Existing tools either miss this entirely or conflate it with project context.

**Decision.** A global developer namespace at `~/.agentctx/profile/` (separate from per-project stores), populated by the same extraction pipeline with `scope: "global"` annotation.

**What gets captured as global:**
- Style preferences (indentation, naming, comment density) — extracted from consistent patterns across sessions
- Process preferences (TDD, planning-first vs autonomous) — from observed workflow patterns
- Tooling preferences (test runner, package manager, deploy approach) — from repeated tool choices
- Cross-cutting conventions (commit message style, PR structure) — from git-adjacent choices

**Accumulation and confidence:** a `scope: "global"` preference extracted from one session gets `confidence: "inferred"`. It upgrades to `confidence: "reinforced"` after appearing consistently across N sessions (configurable, default 3) or one `confidence: "explicit"` statement. Reinforced preferences are injected into every session's SessionStart digest (~200 token budget). Inferred-but-not-reinforced preferences are only injected when directly relevant (UserPromptSubmit FTS5 search).

**Promotion and inspection:** `agentctx profile show` lists the developer's global preferences. `agentctx profile edit <id>` to correct misattributed inferences. `agentctx profile clear <id>` to remove.

---

### ADR-011: Bi-temporal records — supersede, never silently accumulate — **Accepted**

**Context.** Project facts change: "we use REST" → "we moved to gRPC." Naive stores keep both and retrieval returns the wrong one. The two real solutions: Mem0's LLM-arbitrated ADD/UPDATE/DELETE/NOOP (requires API calls mid-session) and Graphiti/Zep's bi-temporal validity intervals. The latter is a data-model idea, separable from Graphiti's Neo4j-and-LLM machinery.

**Decision.** Every context record carries:
```sql
valid_from      TEXT NOT NULL,   -- when the fact became true (ISO 8601)
recorded_at     TEXT NOT NULL,   -- when we ingested it
superseded_at   TEXT,            -- NULL = currently valid
superseded_by   TEXT             -- id of the replacing record
```

- Default retrieval filters `superseded_at IS NULL`
- Superseding is **deterministic**: explicit (`ctx_supersede` MCP call, or the extraction pipeline's `"supersedes": "<old_id>"` field), or rule-based for structured types (a new `profile.test_command` supersedes the old one by key)
- History remains queryable: "what was our auth approach in April?" works
- Nothing is deleted; the consolidation pass may archive records superseded >90 days ago into a cold partition

**Trade-offs.** Without an LLM judge we miss implicit contradictions in prose decisions — two decisions that conflict semantically but don't reference each other. The `ctx_sync_claudemd()` MCP tool (ADR-008) addresses this partially: it compares context store decisions against CLAUDE.md and flags likely conflicts for human confirmation.

---

### ADR-012: Typed records, deterministic observation capture, offline consolidation — **Accepted**

**Context.** Passive transcript capture without typing accumulates noise; recall surfaces trivia. But purely deterministic capture (only explicit `ctx_record` calls) leaves the store empty. The solution is typed extraction via LLM (ADR-009) at session end, plus lightweight deterministic capture for structured signals during the session.

**Decision.** Two capture paths:

**Path A — LLM extraction (session end, primary):** See ADR-009. Extracts decisions, preferences, conventions, handover state, and gotchas from the full session transcript.

**Path B — Deterministic observation capture (PostToolUse, secondary):** Captures structured signals that don't need LLM interpretation:
- File writes: entity link (`file_path` → record association)
- Bash outputs containing error patterns → `bugfix` candidate record (title only; LLM extraction fills rationale)
- Test run outcomes → pass/fail record linked to the test file entity
- Git operations: branch switch, commit, PR → session metadata

Path B records are lightweight stubs; the LLM extraction pass enriches them.

**Record types:**

| Type | Capture source | Scope | Decays? |
|---|---|---|---|
| `decision` | LLM extraction + explicit `ctx_record` | project | No — only supersession |
| `convention` | LLM extraction + explicit `ctx_record` | project | No |
| `preference` | LLM extraction | project \| global | Slow |
| `discovery` | LLM extraction + PostToolUse observation | project | Yes |
| `bugfix` | PostToolUse + LLM extraction | project | Yes |
| `handover` | Stop hook + LLM extraction | project | Fast (one per session, superseded each time) |
| `profile` | Auto-detected on init + CwdChanged | project | Rule-based refresh |

**Offline consolidation pass (SessionEnd, time-boxed):**
1. Embed all `pending_embedding` records in batch (one model load)
2. Near-duplicate scan within each type: cosine similarity > 0.92 → merge candidates, confirm with low-temperature Haiku call
3. Update `score` field: `score = base_relevance × access_decay × recency_decay × confidence_weight`
4. Pre-compute the ranked SessionStart digest
5. Archive records: superseded > 90 days → cold partition; score < 0.1 for > 60 days → candidate for pruning (surfaced in `agentctx status`)

---

### ADR-013: CLAUDE.md staleness detection and sync — **Accepted**

**Context.** CLAUDE.md staleness is one of the three core user pain points explicitly identified: users don't update it; architectural decisions made weeks ago are absent; it drifts from reality. The context store is the ground truth for current decisions — we should use it to detect drift.

**Decision.**

**Detection:** After each extraction pass, the consolidation step compares extracted decisions and conventions against the current CLAUDE.md using FTS5 similarity search. When a high-confidence decision or convention in the store has no matching content in CLAUDE.md (or the match is contradicted), flag it as a drift candidate with a `claudemd_drift_score`.

**Surface:** At the next SessionStart injection, when there are N ≥ 2 drift candidates, include a brief note in the digest: `"2 architectural decisions in the context store are not reflected in CLAUDE.md — run 'agentctx sync' to review."`

**Sync:** `agentctx sync` generates a proposed CLAUDE.md diff: additions for missing decisions, ~~strikethrough~~ for content the store considers superseded, and a line for each drift candidate. The user reviews and applies. We never write to CLAUDE.md without explicit user confirmation.

**MCP tool:** `ctx_sync_claudemd()` returns the proposed changes so Claude can assist in applying them interactively.

**Trade-offs.** FTS5 similarity is imprecise for detecting semantic coverage — it may flag false positives (decision is in CLAUDE.md but phrased differently). Mitigation: drift detection uses a confidence threshold and only triggers the SessionStart note when there are ≥ 2 candidates, not 1.

---

### ADR-014: Graph storage — SQLite adjacency tables, no graph DB — **Accepted**

**Context.** Context records have relationships: decisions supersede each other, conventions apply to specific files/modules, preferences apply globally or per-project. The question is whether to use an embedded graph DB or SQLite with adjacency tables.

**Research findings:**
- **Kuzu** was acquired by Apple and archived on October 10, 2025. The main repo is read-only. There are community forks (Vela, Ladybug, Bighorn) of uncertain longevity. Do not adopt.
- **FalkorDB Lite** (embedded FalkorDB for Node) is v0.3.0 with 7 GitHub stars as of June 2026. Too early-stage; Windows support gaps.
- **AIngram** (a production-patterned local agent memory tool) uses exactly the SQLite + CTE graph + FTS5 + sqlite-vec pattern and reports ~16ms median latency at 1K entries, ~347ms at 100K entries.

**Decision.** SQLite with `nodes` + `edges` adjacency tables, indexed on both endpoints. Graph traversal via `WITH RECURSIVE … UNION` (not `UNION ALL` — `UNION` provides cycle safety at this scale). Depth guard of 5–10 hops on all traversal queries.

**Why this is sufficient.** Our relationship model requires at most 3 hops:
- Decision supersedes → Decision (1 hop)
- Convention applies_to → File/Module (1 hop)
- Preference derives_from → Session (2 hops, rare)

At our scale (<10K nodes typically, <100K at maximum), recursive CTEs in SQLite with proper indexes resolve in well under 10ms. The performance advantage of a graph DB only manifests at hundreds of thousands of nodes and complex multi-hop traversal — the exact workload we don't have.

**Schema (abbreviated):**
```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, project_id TEXT, type TEXT, payload JSON,
  valid_from TEXT, superseded_at TEXT
);
CREATE TABLE edges (
  id TEXT PRIMARY KEY, from_id TEXT, to_id TEXT,
  rel_type TEXT  -- supersedes | applies_to | observed_in | derives_from | scope
);
CREATE INDEX edges_from ON edges(from_id);
CREATE INDEX edges_to ON edges(to_id);
```

**If graph requirements grow:** FalkorDB Lite is the closest embedded option to watch once it matures. The migration from SQLite adjacency tables to FalkorDB Lite is straightforward since the relationship model is simple and well-defined.

---

### ADR-015: Web dashboard — separate package, Hono + Preact + force-graph — **Accepted**

**Context.** The context store spans multiple projects and grows over time. A CLI-only tool makes browsing, editing, and visualizing relationships awkward. A web dashboard is essential for inspectability (a core commitment) and for the future team-context and cloud-sync directions.

**Decision.**

`agentctx ui` starts a local HTTP server and opens the browser. The dashboard is a separate npm package (`@agentctxhq/agentctx-ui`) to keep the base CLI lean. On first `agentctx ui` invocation: prompt "Run `npm install -g @agentctxhq/agentctx-ui` to enable the dashboard."

**Stack:**
- **HTTP server:** `hono` + `@hono/node-server` (~12kB, zero deps, faster than Express)
- **Frontend:** Preact (~3kB gzipped, React-compatible API) as a pre-built SPA, served as static files
- **Graph visualization:** `force-graph` by vasturiano (~45kB gz, Canvas-based, framework-agnostic, d3-force under the hood) for the relationship graph view
- **Build tooling:** esbuild (dev dependency only, not shipped)
- **Browser open:** `open` npm package

**Architecture:**
```
agentctx ui
  → checks for @agentctxhq/agentctx-ui, prompts if missing
  → spawns Hono HTTP server on localhost:7327 (configurable)
  → serves pre-built Preact SPA from package's /dist/
  → serves /api/* JSON endpoints (reads agentctx.db directly)
  → opens browser
```

**Security (local HTTP server):**
- Bind to `127.0.0.1` only (not `0.0.0.0`)
- Validate `Host` header: must be `localhost` or `127.0.0.1` — defeats DNS rebinding attacks
- Check `Sec-Fetch-Site: cross-site` header; reject cross-origin requests — CSRF mitigation
- Generate a random startup secret token; embed in served HTML; require as header on API writes
- No cookies; no session state

**Dashboard views:**
- **Projects**: list all projects, last activity, context record counts
- **Records**: searchable table (FTS5-powered via API) with type/scope filters; edit, pin, supersede
- **Graph**: force-directed relationship visualization (decisions + supersession chains + file entity links)
- **Profile**: developer global preferences, confidence levels, edit/remove
- **Sessions**: session history, token cost, extraction stats
- **Sync**: CLAUDE.md drift report, proposed sync diff

**Future:** The server API is designed for future extension to team/cloud sync (add authentication layer, replace local SQLite reads with remote API calls). The frontend doesn't care about storage backend.

---

### ADR-016: Installation is explicit, reversible, version-stable — **Accepted**

**Context.** agentmemory embeds the package version in hook paths, so every upgrade breaks hooks. Postinstall scripts that silently edit user config files violate trust.

**Decision.**
- No postinstall magic. `agentctx init` is the single explicit setup step: creates `~/.agentctx/`, registers the MCP server (`claude mcp add`-equivalent), writes hook entries into `~/.claude/settings.json` (user scope) or `.claude/settings.json` (project scope, user's choice)
- Hook commands are version-independent: `agentctx hook <event>` resolved via PATH
- `agentctx uninstall` removes everything: hooks, MCP registration, optionally the data directory
- Settings edits are surgical (parse → modify our keys only → write back), idempotent, and preserve all other user settings

**Claude Code plugin as second distribution channel.** The plugin system can bundle hooks + MCP and installs via marketplace. This is attractive distribution ergonomics. Implement as a thin wrapper once the CLI surface is stable (v0.3+).

---

## 4. Data Model (v0.1 schema)

> The normative copy of this schema lives in [SPEC.md §3](./SPEC.md); this section explains its shape. Change SPEC.md first.

```sql
-- Core records (typed, bi-temporal)
CREATE TABLE records (
  id              TEXT PRIMARY KEY,    -- ulid
  project_id      TEXT NOT NULL,       -- git-remote hash or path hash
  type            TEXT NOT NULL,       -- decision|convention|preference|discovery|bugfix|handover|profile
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  scope           TEXT DEFAULT 'project',  -- project | global
  pinned          INTEGER DEFAULT 0,
  confidence      TEXT DEFAULT 'inferred', -- explicit | inferred | reinforced
  reinforce_count INTEGER DEFAULT 0,
  -- bi-temporal (ADR-011)
  valid_from      TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  superseded_at   TEXT,
  superseded_by   TEXT REFERENCES records(id),
  -- retrieval scoring (ADR-012)
  access_count    INTEGER DEFAULT 0,
  last_accessed   TEXT,
  score           REAL DEFAULT 1.0,
  -- CLAUDE.md sync (ADR-013)
  claudemd_drift_score REAL DEFAULT 0.0,
  -- provenance
  source          TEXT NOT NULL,       -- llm_extraction | hook_observation | mcp_tool | cli | import
  session_id      TEXT,
  -- embedding lifecycle (ADR-005/006)
  pending_embedding INTEGER DEFAULT 1
);

-- Graph adjacency (ADR-014)
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, project_id TEXT, kind TEXT,  -- file | symbol | package | module | branch
  name TEXT UNIQUE
);
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  rel_type TEXT NOT NULL,  -- supersedes | applies_to | observed_in | derives_from | scoped_to
  weight REAL DEFAULT 1.0
);
CREATE INDEX edges_from ON edges(from_id);
CREATE INDEX edges_to ON edges(to_id);

-- Entity links (records ↔ code entities)
CREATE TABLE record_entities (record_id TEXT, entity_id TEXT);

-- Session dedup + metadata
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, project_id TEXT,
  started_at TEXT, ended_at TEXT,
  tokens_injected INTEGER DEFAULT 0, extraction_cost_usd REAL DEFAULT 0
);

-- FTS5 index
CREATE VIRTUAL TABLE records_fts USING fts5(title, body, content=records, content_rowid=rowid);

-- Vector index (when sqlite-vec loads)
-- CREATE VIRTUAL TABLE records_vec USING vec0(record_id TEXT PRIMARY KEY, embedding float[384]);
```

**Chunking policy:** records are short and atomic by construction (50–300 tokens each — one decision, one discovery, one handover section). Embed `[type] [date] [project] title + body` as a prefixed string; the type/date prefix measurably improves typed retrieval.

---

## 5. System Flows

### Session capture flow
```
Claude Code session active
  → user codes, Claude helps
  → Stop hook fires → agentctx extract (detached subprocess)
    → reads transcript JSONL from transcript_path
    → Haiku 4.5 extraction call (async, doesn't block hook return)
    → writes records to SQLite (decisions, preferences, conventions, handover)
  → SessionEnd hook fires → agentctx consolidate (detached subprocess)
    → embed pending records (batch ONNX)
    → near-duplicate merge pass
    → score decay update
    → CLAUDE.md drift scan
    → pre-compute next SessionStart digest → write digest file
```

### Session start flow
```
New or resumed session
  → SessionStart hook fires
  → reads pre-computed digest file (~instant)
  → returns additionalContext ≤1,500 tokens:
    {project_profile} + {active_decisions} + {last_handover} + {developer_profile} + {mcp_index_hint}
  → session begins with full context
```

### Per-turn injection flow
```
User types a message
  → UserPromptSubmit hook fires with prompt text
  → FTS5 BM25 search: SELECT records WHERE body MATCH ? AND superseded_at IS NULL
  → filter: exclude record_ids already in /tmp/agentctx-<session_id>.json
  → take top-3, format as additionalContext ≤2,000 tokens
  → append injected IDs to /tmp/agentctx-<session_id>.json
  → Claude sees the relevant context alongside the prompt
```

---

## 6. Defensible Position

From the competitive analysis, the ground this architecture uniquely claims:

1. **Context vs memory** — decisions are first-class bi-temporal records, not log entries; the only tool with deterministic supersession at no LLM cost
2. **LLM enrichment that's honest about cost** — on by default, but transparent: $0.015/session, reported in `agentctx status`, opt-out with a flag
3. **Query-aware per-turn injection without a model** — FTS5 search against the actual user prompt; not recency-based blindness, not an extra LLM call per turn
4. **The token-budget contract** — injection bloat is the category leader's #1 complaint; our 1,500-token cap and per-turn dedup are architectural, not configurable
5. **CLAUDE.md staleness detection** — addresses the core user pain point (stale files) that no competitor touches
6. **Developer profile across projects** — cross-project preferences captured by the same extraction pipeline; unserved by every competitor
7. **No infrastructure** — one process at a time, one file, runs unattended; the opposite of the market
8. **Local web dashboard** — inspectable, explorable, the surface the team-context and cloud-sync directions need

---

## 7. Open Questions

- **OQ-1** *(resolved at v0.1)*: `better-sqlite3` requires prebuilds for each Node major. **Support matrix: Node 20, 22, and 24 — the LTS lines with published prebuilds in the pinned better-sqlite3 major.** `agentctx init` rejects Node < 20 up front with a clear message; on newer majors without prebuilds, the native-module load failure (ABI mismatch after an nvm switch, or a missing binding) is translated into the same support-matrix guidance instead of a node-gyp compile or a stack trace (`cli/node-support.ts`). We never compile native code on the install path (ADR-003). Re-test the matrix when new Node majors ship (tracked again under v0.4 hardening).
- **OQ-2** *(resolved at v0.1)*: Haiku 4.5 extraction requires an Anthropic API key. Detection is by presence of `ANTHROPIC_API_KEY` in the extraction subprocess's environment: absent or empty → log one line and exit 0 with no API call, leaving deterministic capture (PostToolUse stubs, explicit records, init-detected profile) as the working baseline per SPEC §8 rung 3. Injection, digest, and MCP remain fully functional over what exists; verified end to end in `test/e2e.test.ts`. OAuth-only Claude Code users therefore get a silently degraded (never broken) experience.
- **OQ-3:** Worktree semantics — should two worktrees of the same repo share the project context store, with handovers scoped per-worktree? Likely yes (matches Claude Code's own memory behavior). Decide when implementing `WorktreeCreate` support.
- **OQ-4:** Eval story. A small public benchmark (seeded repo + scripted sessions + extraction quality scoring) would differentiate from the market where all benchmarks are self-reported. Scope for v0.4.
- **OQ-5:** Cloud sync architecture for team and future paid tier. The web dashboard API is designed for this extension, but the sync protocol, conflict resolution, and auth model are not yet decided. Revisit at v0.5.
