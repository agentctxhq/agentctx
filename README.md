# agentctx

The context layer for AI coding agents.

> Early work in progress. Claude Code first, via MCP.

---

## What is this

AI coding agents are powerful but amnesiac. Every new session, Claude Code or Cursor starts from scratch — unaware of your architecture, the decisions you made last week, or where you left off.

Most solutions treat this as a memory problem. agentctx treats it as a context problem.

**Memory is a log of what happened. Context is a structured understanding of what you are building.**

agentctx runs as a local MCP server on your machine. It maintains structured project context across every session — architecture decisions, active work, patterns, preferences — so your agent picks up where it left off.

No API key. No cloud. Everything in `~/.agentctx/` on your disk.

---

## Install

```bash
npm install -g @agentctxhq/agentctx
```

---

## Status

| Integration  | Status       |
|--------------|--------------|
| Claude Code  | In progress  |
| Cursor       | Planned      |

This project is in active early development. Expect breaking changes.

---

## Roadmap

- `v0.1` — MCP server, local SQLite storage, Claude Code integration
- `v0.2` — Cursor integration, context viewer
- `Later` — Open context protocol

---

## License

MIT

---

→ [agentctx.app](https://agentctx.app)