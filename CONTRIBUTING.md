# Contributing to agentctx

Thanks for your interest in contributing. agentctx is a tool built for
AI-assisted development workflows, and we welcome contributions made
with or without AI tooling, as long as you stand behind what you ship.

## Before You Start

- Read [docs/VISION.md](./docs/VISION.md) — it defines what this project is and, just as
  importantly, what it explicitly is not. Feature proposals that conflict with
  its "What agentctx Is Not" section will be declined; argue for a vision
  change first if you think the boundary is wrong
- [docs/SPEC.md](./docs/SPEC.md) is the source of truth for contracts (record types,
  hook behavior, MCP tools, token budgets); [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
  records the reasoning. Changes to either require updating the document in
  the same PR
- Check open issues before starting work on a new feature or fix
- For significant changes, open an issue first to discuss the approach
- Keep PRs focused: one logical change per PR

## Development Setup

This is an npm-workspaces monorepo. The CLI package lives in `packages/agentctx`.

```bash
npm ci          # install (Node ≥ 20, see .nvmrc)
npm run build   # compile TypeScript
npm run test    # vitest
npm run lint    # biome (lint + format)
npm run check   # everything CI runs
```

## Contribution Standards

- Write code you understand and can explain
- Include tests for any new behavior where applicable
- Keep commits clean and use [Conventional Commits](https://www.conventionalcommits.org) style
  (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`)
- Update documentation if your change affects behavior or usage

## On Using AI Tools

agentctx exists to make AI-assisted development better, so we have
no issue with contributors using AI tools. That said:

- You are fully responsible for every line you submit, AI-generated or not
- Do not submit AI-generated code you do not understand or have not reviewed
- If a PR is largely AI-generated, mention it briefly in the PR description
- AI does not substitute for testing, reasoning, or thoughtful design

The bar is simple: could you explain and defend this code in a review? If yes, ship it.

## Contributor License Agreement

By submitting a pull request, you agree that:

1. Your contribution is your original work or you have the right to submit it
2. You grant the project maintainer a perpetual, worldwide, irrevocable,
   royalty-free license to use, reproduce, modify, and redistribute your
   contribution as part of this project, including under any future license
   the project may adopt
3. You understand this project is licensed under the Elastic License 2.0

This is a lightweight CLA embedded in our contribution process. No separate
signature is required. Opening a PR constitutes agreement.

## Questions

Open a [GitHub Discussion](https://github.com/agentctxhq/agentctx/discussions)
for anything that is not a bug or feature request.