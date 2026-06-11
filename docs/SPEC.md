# agentctx Specification

This document is the *what*: the normative definition of how context is structured, what the hook and MCP contracts are, and what is stored versus inferred versus derived. When an implementation debate happens, this document settles it. If the implementation and this document disagree, one of them is wrong and must be fixed — silently diverging is not an option.

Scope: this spec covers the **v0.1 surface** unless a section is explicitly marked with a later milestone. The rationale behind these contracts lives in [ARCHITECTURE.md](./ARCHITECTURE.md) (ADR references throughout); sequencing lives in [ROADMAP.md](./ROADMAP.md); intent lives in [VISION.md](./VISION.md).

The key words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as in RFC 2119.

---

## 1. Invariants

These hold across all milestones. Violating one requires changing this document and the corresponding ADR first.

1. **No daemon.** Every agentctx process is short-lived: invoked by a hook, the CLI, or MCP stdio; does its work; exits. Background work runs as detached subprocesses with bounded lifetimes. (ADR-002)
2. **Hard injection budgets.** SessionStart ≤ 1,500 tokens. UserPromptSubmit ≤ 2,000 tokens per turn, session-deduplicated. Budgets are enforced in code by truncation — never overflow, never configurable upward. (ADR-007)
3. **Superseded facts never surface in default retrieval.** Every retrieval path (hooks, MCP, CLI) MUST filter `superseded_at IS NULL` unless the caller explicitly requests history. (ADR-011)
4. **No compiler on the install path.** Every dependency on the critical install path ships prebuilt binaries for supported platforms. (ADR-003)
5. **No unconfirmed writes to user-controlled files.** CLAUDE.md, MEMORY.md, `.gitignore`, `~/.claude/settings.json` beyond our own surgical keys — all require explicit user action. (ADR-013, ADR-016)
6. **Synchronous hooks never load an ONNX model.** Embedding work is offline-only (SessionEnd consolidation). (ADR-006)
7. **All derived data is rebuildable.** Scores, digests, embeddings, and drift flags can be deleted and regenerated from stored records without information loss (§7).

---

## 2. Technology Stack and Platform Constraints

The concrete technical choices, stated normatively. The reasoning and rejected alternatives live in the referenced ADRs in [ARCHITECTURE.md](./ARCHITECTURE.md). Swapping any item below is a spec change.

### 2.1 Stack

| Concern | Choice | Constraint | ADR |
|---|---|---|---|
| Runtime | Node.js, current LTS | No Bun, no Deno. Support matrix for new Node majors is OQ-1 | ADR-002 |
| Package | `@agentctxhq/agentctx`, single CLI binary `agentctx` | No postinstall scripts; setup only via explicit `agentctx init` | ADR-016 |
| SQLite driver | `better-sqlite3` | Bundled SQLite MUST have FTS5 compiled in; N-API prebuilds for all supported platforms | ADR-003 |
| Database | Single file `~/.agentctx/agentctx.db`, WAL mode | WAL is required — concurrent async hooks are parallel writers | ADR-002/003 |
| Vector storage (v0.2) | `sqlite-vec` loadable extension | Delivered as prebuilt platform binaries via `optionalDependencies`; brute-force search only, no ANN | ADR-003/005 |
| Embedding runtime (v0.2) | `@huggingface/transformers` v4 (ONNX) | Offline-only after first download (`allowRemoteModels = false`); NEVER loaded in synchronous hooks | ADR-006 |
| Embedding model (v0.2) | `bge-small-en-v1.5` q8 — ~34 MB, 384 dims | Lazy-downloaded to `~/.agentctx/models/`, never bundled in the npm package; query-side prefix handled internally. Opt-in quality tier: EmbeddingGemma-300m q4, truncated to 256 dims | ADR-006 |
| Extraction model | Claude Haiku 4.5 via the Anthropic API | Detached subprocess only; prompt caching on the system prompt; no API key → degrade per §8 rung 3 | ADR-009 |
| MCP transport | stdio, registered at user scope | No HTTP/SSE server for MCP (that would be a daemon) | ADR-001/002 |
| Record IDs | ULID | Sortable by creation time | §3.1 |
| Graph | SQLite `nodes`/`edges` adjacency tables, recursive CTEs | `WITH RECURSIVE … UNION` (cycle-safe), depth guard 5–10 hops. No graph database | ADR-014 |
| Dashboard (v0.2) | Separate package `@agentctxhq/agentctx-ui`: Hono + `@hono/node-server`, pre-built Preact SPA, `force-graph`, esbuild (dev-only) | Binds 127.0.0.1 only; Host-header validation; `Sec-Fetch-Site` check; startup secret token. Not a dependency of the base CLI | ADR-015 |

### 2.2 Dependency rules

- The base package targets **zero runtime dependencies beyond `better-sqlite3`** in v0.1; every addition must be justified against an ADR.
- Native binaries ship as prebuilds, platform-targeted via `optionalDependencies` (the esbuild/sharp pattern). A failed optional install MUST degrade per §8, never fail `npm install`.
- Forbidden by standing decision: `node:sqlite` (no FTS5), Chroma/LanceDB (second storage system), embedded graph DBs (Kuzu archived; FalkorDB Lite immature), Express (Hono chosen), Docker, anything requiring node-gyp compilation on the install path.

### 2.3 Performance envelope

These numbers are design inputs, not aspirations — they constrain where work is allowed to run:

| Operation | Cost | Consequence |
|---|---|---|
| Node process startup | ~50–100 ms | Acceptable per hook invocation; rules out anything heavier at hook time |
| SQLite FTS5 query | ~1–5 ms after connection open | UserPromptSubmit total target ≤ 150 ms (30 s hook ceiling) |
| SessionStart | file read of pre-computed digest | Effectively instant; digest is NEVER computed inline |
| ONNX model cold start | 2–15 s per process | Embeddings are offline-only (Invariant 6) |
| LLM extraction | seconds, ~$0.015/session | Detached subprocess after Stop; zero hook latency |
| Vector scan at our scale (<10K records) | single-digit ms brute-force | No ANN index, ever (crossover is ~100K vectors) |

### 2.4 Filesystem layout

```
~/.agentctx/
  agentctx.db          # canonical store (SQLite, WAL)
  config.json          # settings: llm, embeddings, modelTier, reinforceThreshold
  profile/             # global developer preference export
  models/              # embedding model cache (v0.2, lazy-downloaded)
/tmp/agentctx-<session_id>.json   # per-session injection dedup (derived, disposable)
<repo>/.agentctx/context.md       # git-committable team export (v0.3, derived)
```

---

## 3. Context Model

### 3.1 Record

The unit of context is the **record**: typed, atomic (one fact per record, 50–300 tokens), bi-temporal. Canonical storage is SQLite (`~/.agentctx/agentctx.db`, WAL mode); Markdown is a first-class export, never the source of truth (ADR-004).

The normative schema:

```sql
CREATE TABLE records (
  id              TEXT PRIMARY KEY,        -- ulid
  project_id      TEXT NOT NULL,           -- see §3.4 Namespacing
  type            TEXT NOT NULL,           -- see §3.2
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  scope           TEXT DEFAULT 'project',  -- project | global
  pinned          INTEGER DEFAULT 0,
  confidence      TEXT DEFAULT 'inferred', -- explicit | inferred | reinforced
  reinforce_count INTEGER DEFAULT 0,
  -- bi-temporal (ADR-011)
  valid_from      TEXT NOT NULL,           -- when the fact became true (ISO 8601)
  recorded_at     TEXT NOT NULL,           -- when we ingested it
  superseded_at   TEXT,                    -- NULL = currently valid
  superseded_by   TEXT REFERENCES records(id),
  -- retrieval scoring (derived, §7)
  access_count    INTEGER DEFAULT 0,
  last_accessed   TEXT,
  score           REAL DEFAULT 1.0,
  -- CLAUDE.md sync (derived, §7)
  claudemd_drift_score REAL DEFAULT 0.0,
  -- provenance (§7)
  source          TEXT NOT NULL,           -- llm_extraction | hook_observation | mcp_tool | cli | import
  session_id      TEXT,
  -- embedding lifecycle
  pending_embedding INTEGER DEFAULT 1
);

CREATE VIRTUAL TABLE records_fts USING fts5(title, body, content=records, content_rowid=rowid);

-- Graph adjacency (ADR-014)
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, project_id TEXT,
  kind TEXT,                               -- file | symbol | package | module | branch
  name TEXT UNIQUE
);
CREATE TABLE edges (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL, to_id TEXT NOT NULL,
  rel_type TEXT NOT NULL,                  -- supersedes | applies_to | observed_in | derives_from | scoped_to
  weight REAL DEFAULT 1.0
);
CREATE INDEX edges_from ON edges(from_id);
CREATE INDEX edges_to ON edges(to_id);

CREATE TABLE record_entities (record_id TEXT, entity_id TEXT);

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY, project_id TEXT,
  started_at TEXT, ended_at TEXT,
  tokens_injected INTEGER DEFAULT 0, extraction_cost_usd REAL DEFAULT 0
);

-- v0.2+: CREATE VIRTUAL TABLE records_vec USING vec0(record_id TEXT PRIMARY KEY, embedding float[384]);
```

### 3.2 Record types

Seven types. Adding a type is a spec change, not an implementation detail.

| Type | What it captures | Primary source | Scope | Lifecycle |
|---|---|---|---|---|
| `decision` | An architectural or technical choice, with rationale | LLM extraction, `ctx_record` | project | Never decays; superseded explicitly |
| `convention` | A rule about how code is written in this project | LLM extraction, `ctx_record` | project | Never decays; superseded explicitly |
| `preference` | How this developer works (style, process, tooling) | LLM extraction | project \| global | Slow decay; confidence lifecycle (§3.3) |
| `discovery` | Something learned about the codebase or its behavior | LLM extraction, PostToolUse | project | Decays |
| `bugfix` | A bug, its cause, and its fix | PostToolUse stub + LLM enrichment | project | Decays |
| `handover` | Active task, blockers, next steps at session end | Stop hook + LLM extraction | project | One current per project; each new one supersedes the last |
| `profile` | Project metadata: stack, commands, entry points | Auto-detected at init / cwd change | project | Rule-based refresh by key |

### 3.3 Confidence lifecycle

`confidence` is a trust discriminator on every record:

- `explicit` — the developer directly stated or did it. Assigned when the source is `ctx_record`, `ctx_supersede`, the CLI, or when the extraction model marks a statement as direct.
- `inferred` — a pattern the extraction model observed. Starts with lower retrieval score. MUST NOT be presented to Claude as established fact in injection (digest formatting distinguishes the two).
- `reinforced` — an inferred record that appeared consistently across **N sessions (default 3, configurable)** or was confirmed by one explicit statement. Reinforced global preferences become eligible for the SessionStart digest.

Transitions are one-way: `inferred → reinforced` (via `reinforce_count`), or any → superseded. There is no downgrade; a wrong record is superseded or deleted, not demoted.

### 3.4 Namespacing

- `project_id` = SHA-256 of the normalized git remote URL (origin, lowercased, credentials and `.git` suffix stripped, `git@host:path` and `https://host/path` forms unified). Fallback when no remote: SHA-256 of the absolute repo root path. Two clones of the same repo on one machine therefore share a namespace; a fork with a different remote does not.
- Global developer profile lives in the same database with `scope = 'global'` and a reserved `project_id = '_global'`; surfaced at `~/.agentctx/profile/` via export.
- Cross-project reads are forbidden except for `scope = 'global'` records. A project's retrieval MUST only see its own namespace plus the global namespace.

### 3.5 Supersession semantics

- Superseding sets `superseded_at` (timestamp) and `superseded_by` (new record id) on the old record, and creates the new record with `valid_from = now`. Nothing is ever deleted by supersession.
- Supersession is **deterministic**: an explicit `ctx_supersede` call, the extraction pipeline's `supersedes` field, or rule-based for keyed types (`handover` per project; `profile` per key). There is no LLM arbitration pass at read or write time.
- History queries (`as_of`) are a v0.3 surface; the data model supports them from v0.1.

---

## 4. Hook Contract

agentctx registers these Claude Code hooks at `agentctx init`. All hook commands are PATH-resolved (`agentctx hook <event>`), never version-pinned paths (ADR-016).

| Event | Sync? | Budget | Behavior |
|---|---|---|---|
| `SessionStart` | Yes | ≤ 1,500 tokens, must return near-instantly | Read the pre-computed digest file; emit as `additionalContext`. Re-runs on resume (`source: "resume"`). MUST NOT query-compute the digest inline. |
| `UserPromptSubmit` | Yes (30s hook timeout; target ≤ 150ms) | ≤ 2,000 tokens/turn, top-3 records, total `additionalContext` ≤ 8,000 chars | FTS5 BM25 search on the literal prompt text → recency/type/pinning rerank → exclude IDs already injected this session → inject, then append injected IDs to the session dedup file. |
| `Stop` | Returns immediately | none | Spawn detached `agentctx extract --session-id <id> --transcript <path>`; do not wait. |
| `PreCompact` | Yes | minimal | Snapshot active working state (current handover candidate) before compaction destroys it. |
| `PostToolUse` | Async | none | Deterministic observation capture only (§7): entity links, error-pattern stubs, test outcomes, git ops. MUST NOT call an LLM or load a model. |
| `SessionEnd` | Async | none | Spawn detached `agentctx consolidate`: embedding backfill (v0.2), dedup scan, score update, CLAUDE.md drift scan, pre-compute the next SessionStart digest. |

Session-scoped dedup state lives at `/tmp/agentctx-<session_id>.json` (injected record IDs). Losing this file degrades gracefully: worst case is re-injection, never an error.

**Digest composition (SessionStart, ≤ 1,500 tokens total):** project profile ~200t + active decisions ~500t + last handover ~400t + reinforced global preferences ~200t + MCP index hint ~100t + CLAUDE.md drift hint ~60t (omitted when < 2 drift candidates). Truncate from the bottom of this list, never overflow.

---

## 5. MCP Server Contract

Seven tools over stdio, registered at user scope. This is a hard cap in v0.1: adding a tool is a spec change. The contract is **progressive disclosure**: search returns a compact index; full content only by explicit `ctx_get`. No tool may bulk-return the store.

All tools MUST filter superseded records by default and MUST scope reads per §3.4. Errors return a structured `{error: string, degraded?: string}` — never throw raw exceptions into the MCP channel.

### `ctx_search(query, type?, file?, scope?, limit?)`
- `query` string, required. `type` one of §3.2. `scope`: `project` (default: project + global), `global`. `limit` ≤ 15, default 10.
- Returns a compact index, ≤ 50 tokens per result: `{id, type, title, age, confidence, score}`.
- Engine: FTS5 BM25 + recency/type/pinning rerank. When FTS5 is unavailable the response includes `degraded: "like-search"` (§8).
- MUST NOT return record bodies.

### `ctx_get(ids[])`
- ≤ 10 ids per call. Returns full records including bi-temporal fields and provenance.
- Side effect: increments `access_count`, sets `last_accessed` (feeds derived scoring, §7).
- Unknown ids are returned in a `missing` array, not an error.

### `ctx_record(type, title, body, supersedes?, scope?)`
- Explicit capture. Writes with `source = 'mcp_tool'`, `confidence = 'explicit'`, `valid_from = recorded_at = now`.
- `supersedes` (record id) applies §3.5 semantics atomically with the insert.
- Validation: `type` must be one of §3.2; `title` ≤ 120 chars; `body` ≤ 2,000 chars (atomicity by construction).

### `ctx_supersede(old_id, new_body, rationale)`
- Marks `old_id` superseded and creates the replacing record (same type/scope as the old one, `confidence = 'explicit'`). Returns both ids.
- Fails with a structured error if `old_id` is already superseded (the caller should supersede the current head).

### `ctx_project()`
- Returns the project profile: `{name, project_id, stack, commands, entry_points, record_counts_by_type, last_session_at}`.

### `ctx_related(file)`
- Records linked to a file path via `record_entities`/graph edges, compact-index format (same shape and limits as `ctx_search` results).

### `ctx_sync_claudemd()`
- Returns the drift report: `{missing: [...], contradicted: [...], proposed_diff: string}` where each entry references a record id.
- Read-only. Applying changes to CLAUDE.md is always a human/Claude action in the session, never this tool's side effect.

---

## 6. Extraction Contract (LLM, ON by default)

Runs out-of-band (Stop → detached subprocess), Haiku-tier model, ~$0.015/session (ADR-009). Opt-out: `agentctx config --no-llm` → deterministic capture only.

**Input policy by transcript size:** ≤ 15K tokens: full transcript. 15–50K: first 3K + last 17K. > 50K: Map-Reduce (10K chunks, one synthesis call). System prompt carries a cache breakpoint.

**Normative output schema** (structured JSON; any deviation is an extraction bug):

```json
{
  "decisions":   [{"what": "...", "rationale": "...", "supersedes": null, "confidence": "explicit|inferred"}],
  "preferences": [{"category": "style|tooling|process|naming", "rule": "...", "confidence": "explicit|inferred", "scope": "project|global"}],
  "conventions": [{"scope": "file|module|project", "convention": "...", "confidence": "explicit|inferred"}],
  "active_work": {"current_task": "...", "blockers": [], "next_steps": [], "open_questions": []},
  "gotchas":     [{"pattern": "...", "why_it_matters": "..."}],
  "flush_ok": false
}
```

**Extraction rules (enforced via prompt, validated on ingest):**
- Extract only from what the developer said or chose — never from Claude's own suggestions, autonomous commands, or unprompted file contents.
- One entry per distinct fact; empty arrays over invented entries.
- `flush_ok: true` → write nothing (trivial session).
- Ingest validation MUST drop entries that fail schema, exceed the body limit, or duplicate an existing record verbatim. Extraction failures are logged and skipped — they MUST never surface as session errors.

---

## 7. Stored vs Inferred vs Derived

This three-way distinction settles most debates about where logic belongs.

**Stored (ground truth — never regenerated, only superseded):**
- Explicit records (`ctx_record`, `ctx_supersede`, CLI edits, team imports)
- Extraction output that passed ingest validation, with its `confidence` and `source` provenance
- Deterministic observation stubs from PostToolUse (entity links, error stubs, test outcomes, git metadata)
- Session metadata (timestamps, injected-token counts, extraction cost)
- Bi-temporal fields — history is part of ground truth

**Inferred (stored, but flagged and on probation):**
- Anything with `confidence: 'inferred'`. It is real data with provenance, but the system MUST treat it as a hypothesis: lower retrieval score, excluded from the SessionStart digest until reinforced, correctable via `agentctx profile edit` / dashboard.

**Derived (rebuildable caches — deleting them MUST lose nothing):**
- `score`, `access_count`-based decay, `claudemd_drift_score`
- The pre-computed SessionStart digest file
- Embeddings and the vector table (v0.2)
- The session dedup file in `/tmp`
- `.agentctx/context.md` team export (v0.3) — regenerable from the store; hand-edits are honored only via explicit round-trip import

Rule of thumb: if it can be recomputed from stored records, it is derived and MUST NOT be the only place a fact lives.

---

## 8. Degradation Ladder

Every layer of the retrieval stack has a defined fallback. The tool MUST remain functional at every rung, and responses below rung 1 carry a `degraded` marker.

1. **Default:** FTS5 BM25 + recency rerank (real-time); vectors offline-only (v0.2 adds hybrid RRF to the digest).
2. **sqlite-vec unavailable:** skip all offline vector work; keyword retrieval unaffected.
3. **No API key / `--no-llm`:** deterministic capture only (PostToolUse stubs, explicit records, rule-based handover). Injection and MCP fully functional over what exists.
4. **FTS5 unavailable** (should not occur with better-sqlite3): LIKE-based search, `degraded: "like-search"`.
5. **Everything degraded:** return pinned records only. Never error into the session.

---

## 9. Token Budget Summary (normative)

| Surface | Budget | Enforcement |
|---|---|---|
| SessionStart injection | ≤ 1,500 tokens | Truncate from the bottom of the digest composition |
| UserPromptSubmit injection | ≤ 2,000 tokens/turn, top-3 records, ≤ 8,000 chars | Drop lowest-ranked first; session-deduped |
| `ctx_search` result | ≤ 50 tokens/result, ≤ 15 results | Index format only, no bodies |
| Record size | 50–300 tokens target, body ≤ 2,000 chars | Ingest validation |
| Self-accounting | Every injection records its token estimate | Reported via `agentctx status` |
| Digest drift hint | ≤ 60 tokens, omitted when < 2 candidates | Lowest-priority section; truncated first |

---

## 10. Changing This Spec

- Contract changes (record types, tool signatures, budgets, invariants) require: an issue, a PR updating this document **and** the relevant ADR in ARCHITECTURE.md, then the implementation.
- This document describes the current target surface; ARCHITECTURE.md preserves the decision history that got us here. Keep rationale out of this file — link the ADR instead.
