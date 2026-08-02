# Fixture demonstration

The always-on end-to-end test creates a temporary repository with exactly two commits:

1. a working `createBet` baseline, protected response contract, `AGENTS.md`, and valid Node test;
2. a regression that maps the “more than ten guesses” validation case to HTTP 500 and adds a failing
   regression test expecting HTTP 422.

It then executes the real CLI command surface with one injected role-aware fake Codex runtime:

```text
config init
doctor
project add
project audit
task create
task diagnose
task run
task review
task inspect
task diff
task status
task logs
```

The fake runtime supplies strict structured outputs but does not fake Git or verification. The writer
edits only the generated worktree; `node --test` is a real child process. The test proves:

- raw feedback is preserved byte-for-byte;
- normalization, diagnosis, implementation, and review use distinct threads;
- audit/diagnosis/review are read-only and implementation uses workspace-write in the worktree;
- the exact captured diff passes real verification and receives an independent approval;
- phase/model usage and event logs are durable;
- the fixed worktree is dirty and passing;
- primary HEAD, status, content, commit count, and remote set are unchanged;
- primary still fails the regression, demonstrating that no merge or push occurred.

Run it directly:

```bash
pnpm exec vitest run tests/e2e/fixture-demo.test.ts
```

The corresponding user-facing flow is:

```bash
cxo doctor
cxo project add /tmp/cxo-demo-repo --name demo
cxo task create --project demo --from tests/fixtures/feedback.md
cxo task diagnose <task-id>
cxo task run <task-id>
cxo task review <task-id>
cxo task diff <task-id>
cxo task status <task-id>
```

The automated test creates its own temporary path rather than assuming `/tmp/cxo-demo-repo` exists.

The real SDK smoke is intentionally separate and skipped by default:

```bash
RUN_CODEX_E2E=1 pnpm exec vitest run tests/e2e/real-codex-smoke.test.ts
```

It makes one minimal read-only structured call in a temporary Git repository and verifies HEAD/status
remain unchanged.
