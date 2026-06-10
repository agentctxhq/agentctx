# @agentctxhq/agentctx

The context layer for Claude Code — persistent, structured, searchable understanding of what you are building, across sessions.

> Early pre-alpha. Active development is targeting v0.1.

```bash
npm install -g @agentctxhq/agentctx
agentctx init
```

`agentctx init` is the single explicit setup step — there are no postinstall
scripts. It creates `~/.agentctx/`, bootstraps the database, registers the
Claude Code hooks (user scope by default, `--project` for project scope) and
the MCP server, and auto-detects the project profile.

```
agentctx init         set up: data dir, database, hooks, MCP server, profile
agentctx uninstall    remove hooks + MCP registration (--data deletes ~/.agentctx)
agentctx config       get/set llm, embeddings, modelTier, reinforceThreshold
agentctx reset        delete the current project's context records (asks first)
```

Everything is reversible: `agentctx uninstall` removes every change `init`
made, surgically — your other Claude Code settings are never touched.

Full documentation, design docs, and roadmap live in the [GitHub repository](https://github.com/agentctxhq/agentctx).

## License

[Elastic License 2.0](./LICENSE)
