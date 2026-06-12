# agentctx

The context layer for Claude Code.

> v0.1 — the complete working foundation: capture, store, inject.

---

## What is this

Claude Code is powerful but amnesiac. Every new session starts from scratch — unaware of your architecture, the decisions you made last week, or where you left off. You repeat yourself. Tokens get wasted. Quality degrades.

Most solutions treat this as a memory problem. agentctx treats it as a context problem.

**Memory is a log of what happened. Context is a structured understanding of what you are building.**

agentctx enhances Claude Code through hooks, MCP tools, and persistent structured storage. It saves tokens, improves answer quality, and adapts to each repo and each developer's work style — automatically.

No daemon. No cloud. Everything in `~/.agentctx/` on your disk. An Anthropic API key enables session-end LLM extraction (~$0.015/session, out-of-band); without one, agentctx degrades gracefully to deterministic capture.

---

## How it works

agentctx integrates with Claude Code in two ways:

**As an MCP server** — exposes tools Claude can call to query project context, search architectural decisions, get codebase topology, and more.

**As a hook layer** — installs Claude Code hooks that inject a budgeted digest on `SessionStart`, add query-relevant records on `UserPromptSubmit`, capture observations via `PostToolUse`, and run LLM extraction + consolidation when the session ends (`Stop`/`SessionEnd`) — all asynchronously, with no daemon.

Together they give Claude Code a structured, persistent understanding of your project that survives across sessions.

---

## Install

```bash
npm install -g @agentctxhq/agentctx
agentctx init
```

Requires Node 20, 22, or 24 — the LTS lines with `better-sqlite3` prebuilt binaries. agentctx never compiles native code at install time.

`agentctx init` is the only setup step (no postinstall scripts): it creates `~/.agentctx/`, bootstraps the database, registers the Claude Code hooks and MCP server, and detects the project profile. `agentctx uninstall` removes all of it, surgically.

```
agentctx status       context summary, injection token cost, extraction cost
agentctx search <q>   full-text search of the context store
agentctx show <id>    pretty-print a full record
agentctx export       render the context store as organized Markdown
agentctx profile      show/edit/clear global developer preferences
agentctx sync         compare context store against CLAUDE.md, propose additions
```

---

## Status

`v0.1.0` — the v0.1 milestone surface ([ROADMAP](./docs/ROADMAP.md)) is implemented: storage with FTS5 retrieval, budgeted hook injection, session-end LLM extraction, the seven-tool MCP server, CLAUDE.md drift detection, and the full CLI. v0.2 (semantic layer + web dashboard) is next.

---

## Repository layout

```
packages/agentctx/   the @agentctxhq/agentctx CLI package (TypeScript)
docs/                design documents: vision, spec, architecture, roadmap
.github/             CI, issue templates, PR template
```

This is an npm-workspaces monorepo; the web dashboard (`@agentctxhq/agentctx-ui`, v0.2) will land as a sibling package.

## Documentation

| Document | Question it answers |
|---|---|
| [CHANGELOG.md](./CHANGELOG.md) | **What changed** — release notes for every published version |
| [docs/VISION.md](./docs/VISION.md) | **Why** — the problem, what this is not, what success looks like |
| [docs/SPEC.md](./docs/SPEC.md) | **What** — normative contracts: context model, hooks, MCP tools, budgets |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | **Why this shape** — every decision, ADR-style, with trade-offs |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | **When** — milestones from v0.1 to v0.5 |
| [CONTRIBUTING.md](./CONTRIBUTING.md) | How to contribute |

## Development

```bash
npm ci          # install workspace dependencies
npm run build   # compile TypeScript (all packages)
npm run test    # run tests (vitest)
npm run lint    # lint + format check (biome)
npm run check   # lint + typecheck + test, what CI runs
```

Requires Node ≥ 20 (see `.nvmrc`).

---

## License

Elastic License 2.0

---

→ [agentctx.app](https://agentctx.app)
