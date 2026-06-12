# @agentctxhq/agentctx

The context layer for Claude Code — persistent, structured, searchable understanding of what you are building, across sessions.

## Quick start

```bash
npm install -g @agentctxhq/agentctx
agentctx init
```

That's it. `agentctx init` is the single explicit setup step — there are no
postinstall scripts. It creates `~/.agentctx/`, bootstraps the database,
registers the Claude Code hooks (user scope by default, `--project` for
project scope) and the MCP server, and auto-detects the project profile.
From the next Claude Code session on, sessions start knowing your active
task, recent decisions, and where you left off.

Requires Node 20, 22, or 24 (the LTS lines with `better-sqlite3` prebuilt
binaries — agentctx never compiles native code at install time).

Optional: with `ANTHROPIC_API_KEY` set, session-end LLM extraction
(Claude Haiku, ~$0.015/session, fully out-of-band) captures decisions,
conventions, and preferences from your conversations. Without a key,
agentctx degrades gracefully to deterministic capture — nothing breaks.

## Commands

```
agentctx init         set up: data dir, database, hooks, MCP server, profile
agentctx uninstall    remove hooks + MCP registration (--data deletes ~/.agentctx)
agentctx status       context summary, injection token cost, extraction cost
agentctx search <q>   full-text search of the context store
agentctx show <id>    pretty-print a full record
agentctx export       render the context store as organized Markdown
agentctx profile      show/edit/clear global developer preferences
agentctx sync         compare context store against CLAUDE.md, propose additions
agentctx config       get/set llm, embeddings, modelTier, reinforceThreshold
agentctx reset        delete the current project's context records (asks first)
```

Everything is reversible: `agentctx uninstall` removes every change `init`
made, surgically — your other Claude Code settings are never touched.
Everything is inspectable: `agentctx export` renders the whole store as
Markdown, and `agentctx status` reports the exact token and dollar cost
agentctx imposes.

Full documentation, design docs, and roadmap live in the [GitHub repository](https://github.com/agentctxhq/agentctx).

## License

[Elastic License 2.0](./LICENSE)
