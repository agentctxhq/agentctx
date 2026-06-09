# agentctx Roadmap

agentctx is a context layer for Claude Code. This document describes what we are building, why, and in what order.

---

## The Problem

Claude Code has a context problem — not a memory problem. The distinction matters.

**Memory** is a log of what happened. **Context** is a structured understanding of what you are building.

Today, every Claude Code session starts from scratch:

- You re-explain your architecture
- You repeat your coding conventions
- You re-describe where you left off
- Claude re-infers your tech stack, test framework, and file structure
- Architectural decisions made last week are invisible today
- Context degrades as the window fills; quality drops before the session ends

This wastes tokens, produces lower-quality output, and forces developers to act as living documentation systems for their own projects.

---

## The Approach

agentctx integrates with Claude Code through two surfaces:

**MCP server** — a local server Claude can query mid-session to retrieve project context, architectural decisions, codebase topology, and developer preferences.

**Hook layer** — hooks that fire automatically at key Claude Code lifecycle events to capture, store, and inject context without interrupting your workflow.

All storage is local (`~/.agentctx/`). No cloud. No API key. No telemetry.

---

## Milestones

### v0.1 — Foundation
*Goal: session continuity and zero context loss on restart.*

**MCP Server (Core)**
- Local MCP server running on the developer's machine
- Register via `agentctx init` — writes to `.claude/settings.json` automatically
- Tools exposed:
  - `get_project_context` — return active project context summary
  - `get_architecture_decisions` — searchable log of recorded decisions
  - `get_project_metadata` — tech stack, test command, build command, package manager

**Local Storage**
- SQLite database at `~/.agentctx/db.sqlite`
- Per-project namespace keyed by git remote or directory hash
- Schema: sessions, decisions, metadata, preferences

**Session Continuity Hooks**
- `Stop` hook: capture structured session handover (active task, decisions made, files touched, next steps)
- `SessionStart` hook (via MCP tool injection): load handover document and inject as context
- `PreCompact` hook: save context snapshot before autocompact fires
- Eliminates "context lost between sessions" problem

**CLI**
- `agentctx init` — register MCP server + install hooks into `.claude/settings.json`
- `agentctx status` — show current project context snapshot
- `agentctx reset` — clear stored context for current project

---

### v0.2 — Project Adaptation
*Goal: Claude Code adapts to each repo automatically.*

**Project Metadata Registry**
- Auto-detect tech stack on `init` and on `CwdChanged` hook
- Detect: language, framework, test framework, build tool, package manager, entry points
- Store in `~/.agentctx/<project>/metadata.json`
- `SessionStart` hook injects metadata — Claude never re-infers these basics

**Architectural Decisions Log**
- MCP tool: `record_decision(title, rationale, context)` — Claude calls this when significant decisions are made
- MCP tool: `search_decisions(query)` — retrieve relevant past decisions
- `PostToolUse` hook: prompt Claude to record decision after key write operations
- Each decision stored with timestamp, git branch, and affected files

**Codebase Topology Index**
- On `init` and on `PostToolUse` (write): build/update a graph of file relationships
- Track which files are edited together most often
- MCP tool: `get_related_files(filepath)` — return related files and context
- `PreToolUse` hook: when Claude reads a file, inject related architectural notes

**Developer Profile**
- Store coding preferences in `~/.agentctx/profile.json`:
  - indentation, naming conventions, test style, error handling patterns, workflow style
- `agentctx profile` — view and edit preferences
- `SessionStart` hook injects profile as part of initial context

---

### v0.3 — Token Efficiency
*Goal: measurably reduce token burn per session.*

**Context Deduplication**
- Hash context state before each API call
- Skip redundant resubmissions by comparing against last-sent hash
- Context diffing: only resend changed sections

**Smart Context Pruning**
- Track which context sections have been unused for N turns
- MCP tool: `get_token_usage()` — show what's consuming context window space
- `agentctx audit` — report on context sections by cost and recency
- Auto-generate `.claudeignore` suggestions per project type (Node, Python, Go, etc.)

**Compression-Quality Validation**
- `PreCompact` hook: snapshot context state before compaction
- `PostCompact` hook: validate that compaction reduced tokens by ≥30%
- Log compression efficiency metrics per session

**Session Metrics**
- Per-session tracking: tokens in/out, context window % at end, turns, tool calls by type, compaction count
- Store in `~/.agentctx/<project>/sessions/`
- MCP tool: `get_session_insights()` — return productivity trends

---

### v0.4 — Learning and Adaptation
*Goal: agentctx learns from your sessions and gets better over time.*

**Style Inference**
- Analyze code written across sessions to detect consistent patterns
- Auto-update developer profile: indentation, naming, comment density, test structure
- `PostToolUse` hook on Write: extract style signals from written code
- Periodically surface detected patterns: "Detected you prefer arrow functions — want to save this?"

**Workflow Pattern Recognition**
- Track which sequences of tool calls lead to successful outcomes
- Identify developer workflow style (plan-first vs. autonomous, test-first vs. test-after)
- Surface suggestions: "You run tests after every change — want agentctx to automate this?"

**Instruction Impact Scoring**
- Track which CLAUDE.md rules and instructions Claude followed without prompting
- Score instructions by adherence impact
- `agentctx audit-instructions` — surface low-impact rules (candidates for removal) and high-impact rules (keep and reinforce)

**Worktree Context Inheritance**
- `WorktreeCreate` hook: automatically copy parent context, profile, and decisions to new worktree
- Create branch-specific context namespace
- Pre-populate with recent decisions from parent branch

---

### v0.5 — Team Context
*Goal: shared architectural knowledge that survives beyond any individual developer.*

**Team Decisions Layer**
- Separate namespace for team-wide decisions (`~/.agentctx/<project>/team-decisions.md`)
- Checked into the repo so it's shared across developers
- MCP tool: `get_team_context()` — return shared architectural knowledge
- `SessionStart` hook loads team context alongside personal preferences

**Onboarding Packages**
- `agentctx export-onboarding` — generate a comprehensive onboarding document
  - Architecture overview, key decisions, build/test commands, common workflows, known gotchas
- `agentctx import-onboarding <path>` — bootstrap context for a new developer
- New developers start with full project context, not from scratch

---

## Hook Reference

agentctx uses the following Claude Code hooks:

| Hook | Purpose |
|------|---------|
| `Stop` | Capture session handover document before session ends |
| `SessionStart` (via MCP) | Inject project context, developer profile, recent decisions |
| `PreCompact` | Snapshot context before autocompact; validate post-compaction quality |
| `PostCompact` | Log compression efficiency; alert if reduction < 30% |
| `PreToolUse` (Read) | Inject related architectural notes before Claude reads a file |
| `PostToolUse` (Write) | Prompt decision recording; extract style signals; update topology index |
| `CwdChanged` | Detect project switch; load new project context |
| `WorktreeCreate` | Inherit context from parent branch into new worktree |

---

## MCP Tools Reference

Tools exposed by the agentctx MCP server:

| Tool | Description |
|------|-------------|
| `get_project_context` | Return current project context summary |
| `get_architecture_decisions` | Return log of recorded architectural decisions |
| `search_decisions(query)` | Semantic search over decision history |
| `record_decision(title, rationale, context)` | Save an architectural decision |
| `get_project_metadata` | Return tech stack, test command, build command |
| `get_related_files(filepath)` | Return files commonly edited alongside this one |
| `get_developer_profile` | Return coding preferences and workflow style |
| `get_session_insights` | Return token usage and productivity trends |
| `get_token_usage` | Show what's consuming the current context window |
| `get_team_context` | Return shared team architectural decisions |

---

## Design Principles

**Local-first.** All data lives in `~/.agentctx/` on the developer's machine. No cloud storage, no API keys, no tracking.

**Context, not memory.** We store structured understanding of what is being built — not a transcript of what happened.

**Zero friction.** `agentctx init` is a one-time setup. After that, it works silently in the background.

**Claude Code only.** We are building deep, high-quality integration with Claude Code. No plans for other agents until this integration is excellent.

**Unobtrusive.** agentctx enhances Claude Code; it does not replace it or change how you work. The goal is to make your existing workflow better.

---

## What is not on the roadmap

- Cursor integration
- Cloud sync or remote storage
- Web dashboard or UI
- Support for other AI coding agents
- Open context protocol (revisit after v0.5 is solid)
