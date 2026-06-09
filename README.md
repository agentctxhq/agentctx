# agentctx

The context layer for Claude Code.

> Early pre-alpha. Active development underway.

---

## What is this

Claude Code is powerful but amnesiac. Every new session starts from scratch — unaware of your architecture, the decisions you made last week, or where you left off. You repeat yourself. Tokens get wasted. Quality degrades.

Most solutions treat this as a memory problem. agentctx treats it as a context problem.

**Memory is a log of what happened. Context is a structured understanding of what you are building.**

agentctx enhances Claude Code through hooks, MCP tools, and persistent structured storage. It saves tokens, improves answer quality, and adapts to each repo and each developer's work style — automatically.

No API key. No cloud. Everything in `~/.agentctx/` on your disk.

---

## How it works

agentctx integrates with Claude Code in two ways:

**As an MCP server** — exposes tools Claude can call to query project context, search architectural decisions, get codebase topology, and more.

**As a hook layer** — installs Claude Code hooks that automatically capture context on `SessionEnd`, inject it on `SessionStart`, and enrich tool calls via `PreToolUse`/`PostToolUse`.

Together they give Claude Code a structured, persistent understanding of your project that survives across sessions.

---

## Install

```bash
npm install -g @agentctxhq/agentctx
agentctx init
```

---

## Status

This project is in early pre-alpha (`v0.0.1`). The current codebase is a placeholder stub.

Active development is targeting `v0.1`. See [ROADMAP.md](./ROADMAP.md) for the full plan and [ARCHITECTURE.md](./ARCHITECTURE.md) for the technical design and the reasoning behind it.

---

## License

Elastic License 2.0

---

→ [agentctx.app](https://agentctx.app)