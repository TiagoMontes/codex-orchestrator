# Codex Orchestrator

Codex Orchestrator (`cxo`) is a local TypeScript CLI for safely coordinating Codex work against
external Git repositories. It keeps durable project, task, evidence, usage, and review state while
using isolated Git worktrees for every implementation.

This repository is under active milestone-by-milestone construction. The production workflow and
complete installation guide are added as each verified subsystem lands.

## Requirements

- Node.js 20 or newer
- pnpm
- Git

## Development

```bash
pnpm install
pnpm dev -- --help
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The CLI never merges, pushes, or edits a registered repository's primary checkout.
