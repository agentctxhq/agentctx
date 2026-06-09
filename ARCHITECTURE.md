# agentctx Architecture

This document records the architecture of agentctx, the reasoning behind each decision, and the trade-offs accepted. It is the source of truth for technical direction. The roadmap (ROADMAP.md) describes *when* things ship; this document describes *what* we are building and *why it is shaped this way*.

Decisions are recorded ADR-style: context, decision, alternatives considered, trade-offs accepted. Statuses: **Accepted** (build this), **Provisional** (current best answer, revisit at the noted milestone), **Open** (not yet decided).

---

## 1. Design Philosophy

agentctx is a **context layer**, not a memory log. The distinction drives every decision below:

- **Memory** is a record of what happened: session summaries, observations, conversation facts. Every existing tool in this space (claude-mem, agentmemory, Mem0, mcp-memory-service) is fundamentally a memory log.
- **Context** is a structured model of what is being built: current architecture decisions with status, conventions, module topology, invariants, developer preferences — with explicit handling for facts that change over time.

Five principles, each a direct response to an observed failure mode in competing tools:

| Principle | Failure mode it prevents | Observed where |
|---|---|---|
| **Hard token budgets, always** | Injection bloat — "40% of context consumed at session start" | claude-mem issues #618, #1848 |
| **No daemon, no sidecar** | Process leaks, crashes, port conflicts, fragile workers | claude-mem (Bun/Express worker + Chroma), XMem (Docker + 3 DBs) |
| **No LLM in the default pipeline** | Hidden cost — tools silently burning the user's Claude quota for compression | claude-mem (Agent SDK compression) |
| **Facts can be superseded, never silently wrong** | Stale context — retrieval returns "we use REST" after the move to gRPC | every naive accumulator |
| **Inspectable by humans** | Opaque vector-blob stores users can't audit or trust | most vector-DB tools; basic-memory is praised for the opposite |

---

## 2. System Overview

```
┌─────────────────────────────  Claude Code  ─────────────────────────────┐
│                                                                          │
│  SessionStart ──► hook ──► budgeted digest (≤1,500 tokens, hard cap)     │
│  PreCompact ────► hook ──► snapshot working state before context loss    │
│  PostToolUse ───► hook ──► async capture (typed observations)            │
│  Stop ──────────► hook ──► session handover record                       │
│                                                                          │
│  MCP tools (deferred-loaded) ◄──► progressive disclosure retrieval       │
│      ctx_search → compact index → ctx_get(ids) → full records            │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ hook-invoked CLI (no daemon)
                                   ▼
                      ~/.agentctx/agentctx.db  (single SQLite file)
                      ├── FTS5 (BM25 keyword)       — always available
                      ├── sqlite-vec (exact vector) — when embeddings enabled
                      ├── bi-temporal records       — valid_from / superseded_at
                      └── WAL mode                  — concurrent hook writes
                                   │
                      ~/.agentctx/models/           — lazy-downloaded embedding
                      .agentctx/context.md          — git-committable team export
```

Two integration surfaces, matching the pattern every successful tool converged on:

1. **Hooks** — capture (automatic, deterministic) and cheap injection (small, budgeted)
2. **MCP** — on-demand deep retrieval (Claude decides when to dig)

Hooks-only tools inject indiscriminately; MCP-only tools depend on the model remembering to call them. The hybrid is non-negotiable.

---

## 3. Decisions

### ADR-001: Hooks + MCP dual-surface integration — **Accepted**

**Context.** Claude Code offers two integration mechanisms. Pure-MCP tools (basic-memory, mcp-memory-service without hooks) suffer from passivity: the model must *choose* to call the memory tool, and frequently doesn't. Pure-hook tools inject context whether or not it's relevant — a tax on every session.

**Decision.** Use hooks for capture and a small SessionStart injection; use MCP for deep retrieval. Specifically:

| Hook | Role | Notes |
|---|---|---|
| `SessionStart` | Inject budgeted digest via `additionalContext` | Fires on startup, resume, clear, compact |
| `Stop` | Write session handover record (active task, decisions, next steps) | Receives `transcript_path` — full session JSONL is readable |
| `PostToolUse` | Capture typed observations from Write/Edit/Bash results | **`async: true`** — never blocks the agentic loop |
| `PreCompact` | Snapshot working state before compaction destroys it | Compaction is where context goes to die; nobody else exploits this hook |
| `SessionEnd` | Final flush + queue consolidation work | Cannot inject context; cleanup only |
| `CwdChanged` | Switch active project namespace | |
| `SubagentStart` | (Later) inject task-relevant context into subagents | Matcher on agent type |

**Trade-offs.** Hook execution adds latency to the loop; mitigated by `async: true` for all capture hooks (only `SessionStart` is synchronous, and it reads a pre-computed digest — see ADR-007). Hook registration touches the user's `settings.json`, which requires careful, reversible installation (ADR-010).

**Rejected.** MCP-only (passivity), hooks-only (no on-demand depth), and a background watcher process that tails transcript files (that's a daemon — see ADR-002).

---

### ADR-002: No daemon. Hook-invoked CLI writes directly to SQLite — **Accepted**

**Context.** claude-mem runs a persistent Bun/Express worker on a per-user port plus a Chroma vector DB process. Its issue tracker is full of process leaks, macOS crashes, and port conflicts. agentmemory pins an entire runtime engine (iii v0.11.2). XMem needs Docker, Neo4j, MongoDB, and Ollama. Infrastructure is the dominant fragility source in this category.

**Decision.** Every agentctx invocation is a short-lived process: a hook fires, the CLI runs, reads/writes SQLite, exits. SQLite in WAL mode handles concurrent writers (parallel async hooks) safely. Background-style work (consolidation, embedding backfill) runs opportunistically at session boundaries (`SessionEnd`), not in a resident process.

**Trade-offs.**
- Cold-start cost per hook invocation (Node startup, ~50–100ms). Acceptable for async hooks; for `SessionStart` we read a digest pre-computed at the previous `SessionEnd` rather than computing on the fly.
- Embedding model load (~hundreds of ms) per invocation would be too slow *if* we embedded at capture time — so we don't. Capture writes raw text; embedding happens in batch at `SessionEnd` (one process, one model load, all pending chunks).
- No always-on file watching. We accept this; hooks give us all the lifecycle signal we need.

**Rejected.** Resident worker (fragility), lazy-spawned worker with idle timeout (still a daemon, just a sneakier one).

---

### ADR-003: Single SQLite file via `node:sqlite`; `better-sqlite3` as fallback — **Provisional** (revisit at v0.1 release)

**Context.** Native-module compilation is the single most common install failure for npm CLIs. `better-sqlite3` has prebuilds for LTS Node only; off the happy path it falls back to node-gyp source compilation. Node ≥ 22 ships `node:sqlite` built in, supporting `loadExtension()` (needed for sqlite-vec) from Node 23.5+, and FTS5 is compiled into current Node releases.

**Decision.** Require Node ≥ 24 (current LTS) and use built-in `node:sqlite` with `{ allowExtension: true }`. Zero native dependencies on the critical install path. The only native artifact in the system is the sqlite-vec extension binary, delivered as prebuilt platform packages via optionalDependencies (the esbuild/sharp pattern) — and it's optional (ADR-005).

**Design rule: no component on the critical install path may require a compiler.**

**Trade-offs.** Node ≥ 24 excludes users on older Node. Acceptable: our users are Claude Code users, a self-selecting current-tooling population. If telemetry-free feedback proves otherwise, fall back to better-sqlite3 with prebuilds — the storage layer is behind an interface, so the swap is contained.

**Rejected.**
- **better-sqlite3 as primary** — compile-on-install failure mode.
- **LanceDB** — real ANN and good prebuilds, but a second storage system, a much larger binary, and its strengths (millions of vectors) don't apply at our scale.
- **Chroma / any external vector DB** — a process to manage; claude-mem's heaviest fragility source.
- **JSON/JSONL files as the store** — no FTS5, no indexed queries, no transactional concurrent writes from parallel hooks.

---

### ADR-004: SQLite is the source of truth; Markdown is a first-class export — **Accepted**

**Context.** basic-memory inverts this (markdown files as truth, SQLite as index) and is consistently praised for it: users can read and edit their AI's memory, sync it with Obsidian, commit it to git. But files-as-truth forces parsing on every read, makes transactional writes from concurrent hooks hard, and couples the schema to a human-editable format.

**Decision.** The database is canonical. In return, we commit to inspectability as a product feature:
- `agentctx export` renders the full context store as organized Markdown
- `.agentctx/context.md` (per-project, git-committable) is a continuously maintained export of *team-shareable* context (ADR-012)
- `agentctx show <id>` pretty-prints any record
- The schema is documented and stable; the DB is queryable with any SQLite client

**Trade-offs.** Users can't hand-edit the canonical store in a text editor. Mitigation: `agentctx edit <id>` and round-trip import of the exported markdown for the team-context subset.

---

### ADR-005: Hybrid retrieval — FTS5 is the floor, vectors are an enhancement — **Accepted**

**Context.** Two findings converge. (1) Developer queries are keyword-shaped: error strings, function names, flags. BM25 catches `useAuthStore` where a 384-dim embedding whiffs. Practitioners report FTS5 alone carries a surprising share of agent-memory retrieval. (2) Every serious system ended up hybrid (BM25 + vector, fused) — pure vector search has well-documented retrieval misses on code content.

**Decision.** Three-stage retrieval:

1. **FTS5 BM25** (always available, zero dependencies) and **sqlite-vec exact cosine** (when embeddings are enabled), run as parallel top-k queries
2. **Reciprocal Rank Fusion**, k=60: `score = 1/(60 + rank_fts) + 1/(60 + rank_vec)` — no score calibration needed between BM25 and cosine, single SQL query with CTEs
3. **Post-fusion rerank**: exponential recency decay (half-life ~30 days) × type weight; **pinned records and active decisions bypass decay entirely**

**Brute-force vector search, no ANN index.** At our scale (hundreds to low tens-of-thousands of chunks per project), exact scan is single-digit milliseconds; the industry crossover where ANN pays for itself is ~100k vectors. sqlite-vec's stable releases are brute-force only anyway (IVF/DiskANN exist only in alphas — verified against the tracking issue, not the marketing). Exact results, zero index maintenance, zero tuning. If a project ever exceeds ~100k chunks, the first lever is int8 quantization with rescoring, not ANN.

**Degradation ladder** (built in from day one — search must never crash):
1. Full: FTS5 + sqlite-vec + RRF + recency
2. sqlite-vec extension fails to load (exotic platform): brute-force cosine over BLOB-stored Float32Arrays in JS (~50–150ms at 50k chunks — acceptable)
3. No embedding model (declined, failed, offline first run): FTS5 BM25 + recency only; responses carry `degraded: "keyword-only"`
4. FTS5 unavailable (should not happen): LIKE-based search

**Trade-offs.** RRF is rank-based, discarding score magnitudes — occasionally a marginally-relevant FTS hit outranks a strongly-relevant vector hit. Accepted: RRF's calibration-free robustness beats tuned weighted-sum fusion in practice, and the recency/type rerank corrects the worst cases.

---

### ADR-006: Local embeddings via transformers.js; lazy download; keyword-only without it — **Accepted**

**Context.** The no-API-key constraint rules out cloud embeddings. The field has converged on small ONNX models run locally: claude-mem, agentmemory, and mcp-memory-service all use all-MiniLM-L6-v2-class models via transformers.js or ONNX runtime.

**Decision.**
- **Runtime:** `@huggingface/transformers` v4 (HF-maintained, ONNX under the hood, reliable prebuilds, filesystem model cache, hard offline mode via `allowRemoteModels = false` after first download)
- **Default model:** `bge-small-en-v1.5` quantized q8 — ~34 MB, 384 dims, ~6 MTEB points better than the all-MiniLM-L6-v2 everyone else defaults to, at nearly identical size and speed. Requires the documented query-side prefix; we own that detail in the embedding layer.
- **Quality tier (opt-in config):** EmbeddingGemma-300m q4, dims truncated to 256 via Matryoshka — multilingual, best-in-class under 500M params, slower
- **Download UX:** the npm package ships no model (25–35 MB in a tarball is hostile to every CI install). `agentctx init` offers eager download; otherwise first use triggers it with a one-line notice and progress ("Downloading embedding model (34 MB, one-time) → ~/.agentctx/models"). `--no-embeddings` opts out forever; the tool remains fully functional keyword-only.
- **When embedding happens:** never at capture time (would require model load per hook invocation — see ADR-002). Batch at `SessionEnd`: one process, one model load, all pending chunks. A `pending_embedding` flag on records makes the backlog explicit and crash-safe.

**Trade-offs.** English-centric default (bge-small is English-tuned); the quality tier covers multilingual users. First-search-after-install may run keyword-only until the model lands; the `degraded` field makes this visible rather than silent.

**Rejected.** fastembed-js (thin community wrapper, less momentum than transformers.js), node-llama-cpp/GGUF (heaviest option, only justified if we wanted local *generation* — we don't), model2vec static embeddings (~8 MB, ~500x faster, but no official JS implementation; attractive future option for a "instant tier" if we're willing to own a port), bundling the model in the package (install bloat).

---

### ADR-007: Token budget contract — injection is capped, always — **Accepted**

**Context.** Injection bloat is the #1 real-world complaint about the category leader: claude-mem's top issues are literally "uses too much tokens" and "~40% of context consumed at session start." Anything injected at SessionStart taxes *every* session, relevant or not. The tools that avoid this share two mechanisms: hard budgets (agentmemory: 2,000 tokens) and progressive disclosure (claude-mem's own search layer, ironically).

**Decision.** A contract, not a guideline:

- **SessionStart digest: ≤ 1,500 tokens, hard-capped in code.** Content priority: project profile (~200t) → active pinned decisions (~400t) → last session handover (~400t) → a one-line index of what's queryable via MCP (~100t). Truncation drops from the bottom, never overflows.
- **MCP retrieval is progressive disclosure:** `ctx_search` returns a compact index (id, type, title, one-line summary — ~50 tokens/result, ~15 results max). Full records only via explicit `ctx_get(ids)`. Claude drills down only into what it needs.
- **MCP tool count stays small** (≤ ~6 tools). Claude Code defers tool schemas by default, but tool sprawl still costs attention and tokens. One searchable store with typed records beats fifteen specialized tools.
- **Self-accounting:** every injection and tool response includes its own token estimate in metadata; `agentctx status` reports cumulative injection cost per session. We measure the tax we impose.

**Trade-offs.** A 1,500-token digest will sometimes omit something relevant, and Claude must spend a tool call to fetch it. That is the correct trade: a tool call costs ~100 tokens when needed; an oversized digest costs thousands always.

---

### ADR-008: Bi-temporal records — supersede, never silently overwrite or accumulate — **Accepted**

**Context.** Project facts change: "we use REST" becomes "we moved to gRPC." Naive stores keep both and retrieval returns the wrong one — the stale-context failure mode. Only two real solutions exist in the field: Mem0's LLM-arbitrated ADD/UPDATE/DELETE/NOOP (requires an API key — disqualified) and Graphiti/Zep's bi-temporal validity intervals (invalidate, don't delete). The latter is a data-model idea, separable from Graphiti's Neo4j-and-LLM machinery.

**Decision.** Every context record carries:

```sql
valid_from      TEXT NOT NULL,   -- when the fact became true
recorded_at     TEXT NOT NULL,   -- when we learned it
superseded_at   TEXT,            -- NULL = currently valid
superseded_by   TEXT             -- id of the replacing record
```

- Default retrieval filters to `superseded_at IS NULL`
- Superseding is **deterministic, not LLM-judged**: explicit (`agentctx supersede <old> --with <new>`, or the `record_decision` MCP tool with a `supersedes` argument), or rule-based for structured types (a new `metadata.test_command` supersedes the old one by key)
- History is queryable: "what was our auth approach in March?" works
- Nothing is deleted by supersession; the consolidation pass (ADR-009) may eventually archive long-superseded records

**Trade-offs.** Without an LLM judge we will miss *implicit* contradictions (two prose decisions that conflict semantically). Accepted for the default pipeline; an opt-in enrichment pass (ADR-011) can flag suspected conflicts for human confirmation. Note that even Mem0's LLM judge is criticized for exactly this, so we are not far behind the state of the art — at zero cost.

---

### ADR-009: Typed records, deterministic capture, offline consolidation — **Accepted**

**Context.** Passive transcript capture stores everything; without typing, dedup, and consolidation, recall surfaces trivia ("noisy memories" — the field's second most common failure). The converged answer is typed observations at capture time plus a background "dream" pass (OpenAI Dreaming, Anthropic Auto Dream, mcp-memory-service's consolidation) — decay, merge, prune as an offline step, not at capture time.

**Decision.**

**Record types** (closed set, each with its own injection priority and decay profile):

| Type | Source | Decays? |
|---|---|---|
| `decision` | explicit MCP tool call, or user command | No (only supersession) |
| `convention` | explicit, or inferred and confirmed | No |
| `preference` | user corrections, explicit settings | Slow |
| `discovery` | PostToolUse capture (how X works, where Y lives) | Yes |
| `bugfix` | PostToolUse capture (error → resolution pairs) | Yes |
| `handover` | Stop hook (task state, next steps) | Fast (superseded each session) |
| `profile` | project metadata detection | Rule-based refresh |

**Capture pipeline (deterministic, no LLM):** typed extraction from hook payloads → SHA-256 dedup within a 5-minute window → privacy filter (path-based ignores, secret-pattern scrubbing: API keys, tokens, .env contents) → store with `pending_embedding` flag.

**Entity links without LLM extraction:** for a *coding* context tool, the entities are deterministic — file paths, symbols, package names, branch names — extractable by parsing, not inference. Records link to entities; `ctx_search` can filter by file. (This is where conversational-memory tools need an LLM and we structurally don't.)

**Consolidation ("dream") pass** at SessionEnd, time-boxed: embedding backfill → access-based strengthening and Ebbinghaus-style decay scoring (the mcp-memory-service weight vector — time decay, tag relevance, content relevance, access recency — is a proven no-LLM relevance model) → near-duplicate merging (cosine > threshold within same type) → archive of long-dead records.

**Trade-offs.** Deterministic extraction is shallower than LLM extraction — we capture *that* a test command failed and the fix that followed, not a nuanced narrative. Accepted: shallow-but-free and noise-resistant beats rich-but-costly; the structure (types + entities + bi-temporality) recovers most of the value.

---

### ADR-010: Installation is explicit, reversible, and version-stable — **Accepted**

**Context.** agentmemory embeds the package version in hook paths, so every upgrade breaks hooks. npm postinstall scripts that silently edit `~/.claude/settings.json` violate user trust and Claude Code's own consent model (project hooks require workspace trust).

**Decision.**
- No postinstall magic. `agentctx init` is the single explicit setup step: creates `~/.agentctx/`, registers the MCP server (user scope, `claude mcp add`-equivalent), writes hook entries into settings.json
- Hook commands are **version-independent**: they invoke `agentctx hook <event>` resolved via PATH, never a path into a versioned package directory
- `agentctx uninstall` removes every trace: hooks, MCP registration, optionally the data directory
- Settings edits are surgical (parse, modify our keys only, preserve formatting where possible) and idempotent

**Distribution: npm CLI first; Claude Code plugin as a second channel — Provisional.** The plugin system can bundle hooks + MCP + skills and installs via marketplace, which is attractive (it's how claude-mem gets its install ergonomics). But plugins are a packaging layer over the same primitives; the CLI must work standalone first. Revisit at v0.3 once the surface is stable.

---

### ADR-011: LLM enrichment exists, is off by default, and is clearly labeled — **Accepted**

**Context.** Some genuinely valuable operations need a model: summarizing a long session into a handover narrative, flagging semantically conflicting decisions, distilling a week of discoveries into a convention. claude-mem does this silently via the Agent SDK, burning the user's Claude quota — compounding its token-bloat complaints.

**Decision.** The default pipeline is 100% deterministic. An optional enrichment mode (off by default) may use the Claude Agent SDK for: handover narrative polish, conflict flagging (ADR-008), consolidation summaries. When enabled it: runs only at session boundaries, reports its token spend in `agentctx status`, and degrades to the deterministic path silently when unavailable. No agentctx feature may *require* enrichment.

---

### ADR-012: Personal context and team context are separate stores — **Accepted**

**Context.** Market gap: claude-mem is explicitly single-user; Claude Code's native memory is per-machine. Teams want shared architectural decisions; individuals want private preferences. Conflating them is both a privacy bug and a sharing blocker.

**Decision.** Two namespaces with different lifecycles:
- **Personal** (`~/.agentctx/`): preferences, work style, session handovers, discoveries. Never leaves the machine.
- **Team** (`.agentctx/` in the repo, git-committable): decisions, conventions, project profile — maintained as human-readable Markdown (the ADR-004 export), diffable in PRs, merged like any text file. The SQLite store *imports* the team file on SessionStart, so teammates' decisions flow into retrieval automatically.

**Trade-offs.** Git-merge conflicts on the team file are possible; the format is line-oriented (one record per block) to keep them tractable. Promotion from personal to team is always explicit (`agentctx promote <id>`), never automatic — privacy by default.

---

### ADR-013: Position relative to Claude Code's native memory: beneath it, not against it — **Accepted**

**Context.** Claude Code now ships Auto-Memory: a self-edited `MEMORY.md` (~200-line cap, injected every session) plus an "Auto Dream" background reorganization pass. Reviewers' verdict: "use built-in unless you need semantic search or team sharing." A context tool that fights the native system will lose; one that ignores it will duplicate it.

**Decision.** agentctx is the structured, searchable, versioned layer *beneath* the native 200-line working memory:
- Native MEMORY.md = small, hot, prose working set (Letta's "memory block" idea, file-shaped)
- agentctx = the deep store: thousands of typed, bi-temporal, entity-linked, hybrid-searchable records — plus team sharing and cross-machine portability that the native system lacks by design
- We never write to MEMORY.md uninvited. An opt-in bridge may *suggest* promotions of hot agentctx records into it
- If native memory grows search or team features, our differentiation narrows to bi-temporal decisions + team git flow + topology — which is the defensible core anyway (see §5)

---

## 4. Data Model (v0.1 schema sketch)

```sql
CREATE TABLE records (
  id              TEXT PRIMARY KEY,        -- ulid
  project_id      TEXT NOT NULL,           -- derived from git remote, else path hash
  type            TEXT NOT NULL,           -- decision|convention|preference|discovery|bugfix|handover|profile
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  pinned          INTEGER DEFAULT 0,
  -- bi-temporal (ADR-008)
  valid_from      TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  superseded_at   TEXT,
  superseded_by   TEXT REFERENCES records(id),
  -- retrieval scoring (ADR-009)
  access_count    INTEGER DEFAULT 0,
  last_accessed   TEXT,
  score           REAL DEFAULT 1.0,        -- maintained by consolidation pass
  -- provenance
  source          TEXT NOT NULL,           -- hook event | mcp tool | cli | import
  session_id      TEXT,
  -- embedding lifecycle (ADR-006)
  pending_embedding INTEGER DEFAULT 1
);

CREATE TABLE entities (                     -- deterministic: files, symbols, packages
  id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, name TEXT
);
CREATE TABLE record_entities (record_id TEXT, entity_id TEXT);

CREATE VIRTUAL TABLE records_fts USING fts5(title, body, content=records);
CREATE VIRTUAL TABLE records_vec USING vec0(  -- when sqlite-vec loads
  record_id TEXT PRIMARY KEY, embedding float[384]
);
```

Chunking policy: records are short and atomic by construction (50–300 tokens) — one decision, one discovery, one handover section. We embed `title + body` whole, prefixed with type/date metadata (`[decision] [2026-06-09]`), which measurably improves typed retrieval. Transcripts are never embedded raw; they are distilled into records at capture time, with the raw text available to FTS5 only where needed for exact-string recall.

## 5. MCP Tool Surface (deliberately small — ADR-007)

| Tool | Purpose |
|---|---|
| `ctx_search(query, type?, file?)` | Hybrid search → compact index (~50 tokens/result) |
| `ctx_get(ids)` | Full records by id (progressive disclosure step 2) |
| `ctx_record(type, title, body, supersedes?)` | Claude records a decision/convention/discovery |
| `ctx_supersede(old_id, new_id?)` | Mark a fact as no longer current |
| `ctx_project()` | Project profile + metadata (stack, commands, entry points) |
| `ctx_related(file)` | Records and entities linked to a file |

## 6. What Makes This Defensible

From the competitive analysis, the genuinely unoccupied ground this architecture claims:

1. **Decisions as first-class bi-temporal records, no LLM judge required** — nobody does deterministic supersession
2. **Claude Code-native depth** — PreCompact capture, transcript JSONL parsing, async hooks, subagent context: surfaces that 22-agent-compatible tools structurally can't go deep on
3. **The token-budget contract** — the category leader's #1 complaint, solved by design rather than by tuning
4. **Team context through git** — markdown export, PR-diffable, unserved by every competitor and by native memory
5. **No infrastructure** — one process at a time, one file, runs forever unattended

## 7. Open Questions

- **OQ-1:** Should the `SessionStart` digest adapt per-prompt (move injection to `UserPromptSubmit`, retrieving against the user's actual prompt)? Strictly better relevance, but adds a hook on the critical latency path (30s timeout, fires every turn). Prototype in v0.2; measure latency before committing.
- **OQ-2:** Worktree semantics — share project context across worktrees of the same repo (Claude Code's native memory does), with handovers scoped per-worktree? Likely yes; decide when implementing `WorktreeCreate` support.
- **OQ-3:** Windows support level. sqlite-vec ships windows-x64 prebuilds; linux-arm64/musl coverage needs verification. The degradation ladder (JS cosine fallback) means no platform hard-fails — decide what we *test* vs what we *tolerate*.
- **OQ-4:** Eval story. Nearly all competitor benchmarks are self-reported and none publish reproducible evals. A small public benchmark (seeded repo + scripted sessions + retrieval quality scoring) would differentiate; scope it at v0.4.
