# Codex Orchestrator contributor instructions

## TypeScript

- Keep TypeScript strict; do not introduce `any` or weaken compiler checks.
- Validate all external input with Zod before using it as domain data.
- Keep domain, application, orchestration, and infrastructure responsibilities separate.
- Prefer argument arrays over shell command strings.

## Safety

- Never modify a registered project's primary checkout.
- Diagnosis, audit, exploration, and review are read-only.
- Production writes are allowed only in the task's isolated Git worktree.
- Never merge, push, force-push, or delete branches automatically.
- Do not read or persist Codex credential files or secret environment values.
- Network access and native Codex subagents are disabled by default.
- Do not add unbounded retry or agent loops; retries require new deterministic evidence.

## Workflow

- Work milestone by milestone and use Conventional Commit messages.
- Before a milestone commit, run formatting, type checking, relevant tests, and inspect the diff.
- Run all final gates with `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
  `pnpm build`.
- Automated tests must use temporary fixture repositories, never `bravo_backend`.
