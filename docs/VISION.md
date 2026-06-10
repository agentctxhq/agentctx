# agentctx Vision

This document is the *why*. It defines the problem agentctx exists to solve, what the project explicitly is not, and what success looks like. When a proposed feature, PR, or debate doesn't fit within this document, the answer is no — or this document changes first, deliberately.

Companion documents: [SPEC.md](./SPEC.md) defines *what* we build (the normative contracts), [ARCHITECTURE.md](./ARCHITECTURE.md) records *why it is shaped this way* (the decisions), and [ROADMAP.md](./ROADMAP.md) defines *when* it ships.

---

## The Problem

Claude Code is powerful but amnesiac. Three specific failures follow from that, and they are the entire reason this project exists:

1. **CLAUDE.md goes stale.** It is written once, in a burst of good intentions, and then reality drifts away from it. The architectural decision made last month isn't in it. The convention discovered last week isn't in it. Claude operates on an outdated map of the project, and nobody notices until it produces confidently wrong work.

2. **Session switches lose everything.** A new session — the next morning, a different branch, a fresh terminal — starts from zero. The active task, the blockers, the decisions made an hour ago: gone. The developer re-explains, re-establishes, re-decides. Tokens are wasted on re-teaching instead of building.

3. **Developers have no identity across projects.** The way you work — your style, your process, your tooling preferences — is re-learned from scratch in every project and every session. Nothing accumulates. The hundredth session knows you no better than the first.

## The Insight

Most tools in this space treat these as a **memory** problem: log what happened, summarize it, retrieve it later. That framing is wrong, and it is why those tools disappoint.

**Memory is a log of what happened. Context is a structured understanding of what is being built.**

A log accumulates. It cannot tell you that "we use REST" was superseded by "we moved to gRPC" — it happily returns both, and retrieval becomes a liability as the store grows. A context layer maintains a *current model*: decisions with status, conventions with scope, preferences with confidence, and explicit handling for facts that change over time. Old facts are superseded, never silently wrong.

This single distinction — context, not memory — drives every architectural choice in the project.

## What agentctx Is

A context layer for Claude Code. Specifically:

- **Automatic.** Capture happens via LLM extraction at session end, by default. Developers do not make explicit "record this" calls in practice, so a system that depends on them stays empty. (See ADR-009.)
- **Frugal with the context window.** Injection is hard-budgeted: ≤1,500 tokens at session start, ≤2,000 deduplicated tokens per turn. The context window is the user's most expensive resource; we measure and report the tax we impose. Deep retrieval happens on demand via MCP progressive disclosure, never by bulk injection.
- **Infrastructure-free.** No daemon, no sidecar, no Docker, no cloud, no API key required for core function. A hook fires, a process runs, SQLite is read or written, the process exits.
- **Honest about facts over time.** Records are bi-temporal. Superseded facts never surface in default retrieval, but history remains queryable.
- **Inspectable.** The store is plain SQLite plus first-class Markdown export. Users can read, audit, and correct what the system believes about them and their project.

## What agentctx Is Not

These are deliberate exclusions, not gaps. PRs and proposals in these directions will be declined with a pointer to this section.

- **Not a memory log.** We do not store session summaries, conversation transcripts, or chat history as retrievable context. If a proposal's value is "remember everything that happened," it belongs in a different tool.
- **Not multi-agent.** Claude Code only. No Cursor, no Codex, no generic-agent abstraction layer. Claude Code–native depth (hooks, MCP, CLAUDE.md awareness, subagents) is the differentiator; an abstraction layer would forfeit it.
- **Not a replacement for Claude Code's native memory, CLAUDE.md, or skills.** We sit beneath them. We never write to MEMORY.md, CLAUDE.md, or any user-controlled file without explicit confirmation.
- **Not a daemon.** Ever. No resident process, no lazy-spawned worker with an idle timeout, no embedding server. This is the most common failure mode in the category and it is permanently out of scope.
- **Not a RAG-over-codebase tool.** We store *understanding about* the project (decisions, conventions, preferences), not the project's source code. Code search is Claude Code's job.
- **Not infrastructure-hungry.** No ANN indexes, no graph databases, no second storage system, no component on the install path that requires a compiler.
- **Not cloud-first.** Local-first always. Cloud sync (v0.5) is an optional layer on top of a fully functional local tool, never a requirement.

## What Success Looks Like

Success is measurable, and we hold ourselves to these:

| Outcome | Measure |
|---|---|
| Sessions start informed | A new session knows the active task, recent decisions, and where work left off — without the developer re-explaining. Session-start injection never exceeds 1,500 tokens. |
| CLAUDE.md stays current | Drift between the context store and CLAUDE.md is detected automatically and a sync is proposed (never auto-applied). |
| The developer is known | Cross-project preferences accumulate, are inspectable, and are correctable. |
| The store stays correct | Superseded facts never appear in default retrieval, at month one and at month twelve. |
| The tax is visible | Injection token cost and extraction cost (~$0.015/session) are reported in `agentctx status`, not hidden. |
| Install is trivial | One command, no compiler, no daemon, reversible with `agentctx uninstall`. |

And one qualitative bar that matters more than any metric: **a developer who stops using agentctx should notice within a day** — sessions feel forgetful again. If removal is painless, we haven't built anything.

## How to Use This Document

If you're contributing: before proposing a feature, check it against "What agentctx Is Not." If it conflicts, open an issue arguing for a change *to this document* rather than a PR implementing the feature. Scope discipline is a feature; the category is littered with tools that grew until they broke.
