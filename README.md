# Codex Orchestrator

Codex Orchestrator (`cxo`) is a local TypeScript CLI that coordinates Codex against external Git
repositories. It turns raw feedback into a validated task, performs evidenced read-only diagnosis,
implements only in an isolated Git worktree, runs deterministic verification, and sends the exact
verified diff to an independent reviewer. It never merges or pushes.

The orchestrator keeps durable project, task, evidence, decision, usage, diff, verification, and
review records under `~/.codex-orchestrator` (or `CODEX_ORCHESTRATOR_HOME`). Registered repositories
remain independent and do not need orchestrator configuration committed to them.

The state root contains `config.yaml`, global project/task indexes, `projects/<project-id>` metadata
and task artifacts, state-owned `worktrees/<project-id>/<task-id>`, and lock files. It never stores
Codex credentials. `project remove` deletes only that project's orchestrator-owned directory after
all task operations and worktrees are safely resolved; it never deletes the registered repository.

## Requirements

- Node.js 20 or newer
- Git with worktree support
- local Codex authentication usable by `@openai/codex-sdk`
- pnpm 10 for development or source installation

Run `cxo doctor` before creating a task. `cxo doctor --deep` is optional and clearly warns before
making one tiny read-only model call.

## Install globally

From this repository:

```bash
pnpm install
pnpm build
pnpm link --global

cxo --version
codex-orchestrator --version
```

To exercise the same flow as a published package:

```bash
pnpm build
pnpm pack
npm install --global ./codex-orchestrator-0.1.0.tgz
```

Both `cxo` and `codex-orchestrator` point to the same binary. Initialize and validate local state:

```bash
cxo config init
cxo config validate
cxo doctor
```

## Daily workflow

Registering and diagnosing a repository are read-only. `project add` records the canonical Git root,
HEAD, base ref, redacted remotes, stack, verification candidates, layered `AGENTS.md` hashes, and
`.agents/skills` metadata.

```bash
cxo project add /absolute/path/to/repository --name my-project --base-ref main
cxo project inspect my-project
cxo project audit my-project

cxo task create --project my-project --from feedback.md --profile balanced
cxo task diagnose BUG-2026-0001
cxo task run BUG-2026-0001
cxo task review BUG-2026-0001
cxo task diff BUG-2026-0001 --patch
cxo task status BUG-2026-0001
cxo task logs BUG-2026-0001 --tail 100
```

`project inspect` prints the state-owned `project-config.yaml` path. Its verification commands use
literal `command` argument arrays, timeouts, and an explicit `approved` flag. Generated candidates
stay disabled; inspect and approve only commands you trust. The file is strictly validated on every
project lookup, and `project refresh` preserves user edits while refreshing detected metadata. See
[`templates/project.config.example.yaml`](templates/project.config.example.yaml).

`task run` creates a state-owned worktree and task branch at the diagnosed commit. Codex may write
only there. The primary checkout's HEAD, status, and contents are checked throughout the workflow.
Verification runs approved literal argv outside the model; review starts a new thread and is bound to
the exact source commit and diff hash.

If a bounded phase stops:

```bash
cxo task status BUG-2026-0001
cxo task resume BUG-2026-0001
```

Cancel from another process with `cxo task cancel BUG-2026-0001`. The cancellation is persisted,
linked to active SDK/verification abort signals, and preserves a validated resume boundary. Intake
is durable too: interrupted normalization retains the task ID and verbatim feedback, and `task
resume` retries or finalizes its saved normalization plan before diagnosis is allowed.

Cleanup is explicit. A no-flag call is a dry run. Completed dirty worktrees can be removed only after
both the saved patch hash and live diff are validated. Explicitly removing a blocked or cancelled
worktree first captures a new hash-validated recovery patch and terminalizes the task as `failed`;
this is an intentional abandonment, not a resumable cleanup. Branch deletion is a separate flag and
is refused when the branch contains commits not merged into primary `HEAD`.

```bash
cxo task cleanup BUG-2026-0001
cxo task cleanup BUG-2026-0001 --remove-worktree
cxo task cleanup BUG-2026-0001 --remove-worktree --delete-branch
```

## Commands

```text
cxo doctor [--deep]
cxo config init|show|path|validate

cxo project add <path> [--name <name>] [--base-ref <ref>]
cxo project list
cxo project inspect <project>
cxo project audit <project> [execution overrides]
cxo project refresh <project>
cxo project remove <project>

cxo task create --project <project> (--from <file>|--stdin) [--profile <profile>]
cxo task list [--project <project>] [--status <status>]
cxo task inspect <task-id>
cxo task status <task-id>
cxo task diagnose <task-id> [execution overrides]
cxo task run <task-id> [execution overrides]
cxo task review <task-id> [execution overrides]
cxo task diff <task-id> [--stat] [--patch]
cxo task logs <task-id> [--phase <phase>] [--tail <1..1000>]
cxo task resume <task-id>
cxo task cancel <task-id>
cxo task cleanup <task-id> [--remove-worktree] [--delete-branch]
```

Execution commands accept bounded overrides for `--profile`, `--model`, `--reasoning`,
`--max-total-tokens`, `--max-agent-calls`, `--parallel-readers`, `--allow-network`, `--base-ref`, and
`--timeout`. Applied overrides and routing decisions are persisted and shown in task reports.

For task diagnosis, pre-write implementation exploration, and review, `--parallel-readers N`
launches workers only when the planner finds at least two disjoint reports or file scopes. Workers
are depth-one, read-only, network-disabled, and charged to the parent task ledger. Localized or
overlapping work stays serial and the reason is persisted.

Every command supports `--json` before or after the command. Successful output is JSON on stdout;
errors are one JSON object on stderr with a stable code, exit code, resumability, and an optional safe
next command. Stack traces require `--debug`. Non-TTY output and `NO_COLOR=1` contain no ANSI.

Exit codes are `0` success, `1` generic, `2` CLI input, `3` configuration/doctor, `4` project/Git,
`5` task state/lock, `6` Codex runtime, `7` verification, `8` review changes, `9` budget/context,
`10` integrity, and `11` cancellation.

## Bravo Backend example

This is a realistic, non-executed example. Automated tests never access `bravo_backend`.

```bash
cxo project add ~/Projects/bravo_backend --name bravo_backend --base-ref develop
```

Create `feedback-bet-route.md`:

```md
# Broken bet route

Route: POST /bet

Current behavior:
The route returns HTTP 500 when a bet contains more than 10 guesses.

Error:
Undefined array key "position" in BetService.php:184

Expected behavior:

- valid payload creates the bet;
- invalid quantity returns HTTP 422;
- the public response contract must remain unchanged;
- migrations must not be modified;
- a regression test must be added.
```

Then run:

```bash
cxo task create \
  --project bravo_backend \
  --from feedback-bet-route.md \
  --profile balanced

cxo task diagnose BUG-2026-0001
cxo task run BUG-2026-0001
cxo task review BUG-2026-0001
cxo task diff BUG-2026-0001 --patch
cxo task status BUG-2026-0001
```

With the default configuration, a typical visible routing decision is:

```text
Task: BUG-2026-0001
Profile: balanced

Normalization: gpt-5.6-luna / low
Diagnosis: gpt-5.6-terra / medium
Implementation: gpt-5.6-terra / medium
Review: gpt-5.6 / high

Escalation: allowed only with new evidence and remaining budget
Parallel readers: disabled because the bug is localized
Native Codex subagents: disabled
```

Model IDs come from the validated runtime configuration. “Ultra” is not a model ID; the internal
`deepest` reasoning preset maps to supported SDK effort values with at most one compatibility
fallback.

## Reproducible fixture demo

`tests/e2e/fixture-demo.test.ts` creates a temporary two-commit Git repository. Commit one is a good
bet-service baseline. Commit two breaks the quantity guard and adds a failing regression test. The
test drives actual Commander commands through configuration, doctor, registration, audit,
normalization, diagnosis, implementation, verification, review, inspection, diff, status, and logs.

```bash
pnpm exec vitest run tests/e2e/fixture-demo.test.ts
```

It asserts byte-identical feedback preservation, distinct phase threads, real `node --test`
verification, approved review, usage entries, a dirty fixed worktree, and an unchanged primary
checkout that still exhibits the regression. The optional real SDK smoke is disabled by default:

```bash
RUN_CODEX_E2E=1 pnpm exec vitest run tests/e2e/real-codex-smoke.test.ts
```

That opt-in test makes one tiny read-only call in a temporary repository. It never targets a user
project.

## Configuration and skills

`cxo config init` writes a strict versioned YAML configuration. Profiles bound total tokens, agent
calls, attempts, review cycles, turns, and parallel readers. Network access, web search, unrestricted
filesystem access, and native Codex subagents are disabled by default.

Five narrow bundled workflow skills are selected deterministically by task type and phase. Project
skills are read from registered `.agents/skills` metadata without being copied. User
`~/.agents/skills` loading is disabled unless the process explicitly sets
`CODEX_ORCHESTRATOR_ALLOW_USER_SKILLS=1`; selected contents and hashes are integrity-bound in the
context pack.

## Documentation

- [Architecture](docs/architecture.md)
- [Security model](docs/security.md)
- [Context and token governance](docs/context-and-token-governance.md)
- [Model routing](docs/model-routing.md)
- [Task lifecycle](docs/task-lifecycle.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Fixture demonstration](docs/fixture-demo.md)

## Known limitations

- The MVP prepares changes but does not merge, push, open pull requests, or commit task worktree
  changes.
- Automatic verification approval is deliberately narrow: the detector approves the exact command
  `node --test`. PHP, Python, Rust, Go, and alternate Node commands remain disabled candidates until the
  user explicitly approves literal argument arrays in the state-owned project configuration.
  Dependency installation is never automatic.
- Verification uses an allowlisted literal argv and sanitized environment, but the host OS—not the
  CLI—determines process-level network isolation.
- Project audits require a clean checkout and inventory at most 5,000 tracked files. They are
  commit-scoped snapshots; changed evidence, repository instructions, or selected skill hashes make
  them unusable until a new audit.
- Event and command logs are deliberately bounded and redacted. `task diff --patch` intentionally
  emits the complete hash-checked patch and can be verbose for a large change.
- The SDK adapter is pinned to `@openai/codex-sdk` 0.146.0; unsupported model/effort pairs get one
  controlled fallback, then an actionable failure.
- Worktree support and process signaling follow Git and Node behavior on the host; the automated
  release gates exercise macOS/Linux-style environments.
- User skills are disabled without `CODEX_ORCHESTRATOR_ALLOW_USER_SKILLS=1` and remain untrusted,
  subordinate workflow guidance even when enabled.

## Development

```bash
pnpm install
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The default test command includes the complete fake-runtime fixture and reports the real Codex smoke
as skipped.
