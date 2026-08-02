# Troubleshooting

## Start with doctor and status

```bash
cxo doctor
cxo config validate
cxo task status <task-id>
```

Add `--json` for automation and `--debug` only when a stack trace is needed. Exit codes are stable:

| Code | Meaning                                         |
| ---: | ----------------------------------------------- |
|    1 | generic failure                                 |
|    2 | invalid CLI input                               |
|    3 | configuration/doctor failure                    |
|    4 | project or Git repository failure               |
|    5 | invalid task state or active lock               |
|    6 | Codex SDK/runtime failure                       |
|    7 | deterministic verification failure              |
|    8 | review requested changes                        |
|    9 | token, call, attempt, or context budget reached |
|   10 | source/diff/context integrity violation         |
|   11 | operation cancelled                             |

## Configuration is missing or invalid

Run `cxo config init`, then `cxo config show` and `cxo config validate`. To isolate a test or CI run,
set `CODEX_ORCHESTRATOR_HOME` to an absolute disposable directory before initialization.

## Codex authentication/model access fails

Normal `doctor` spends no tokens. Use `cxo doctor --deep` only after reading its warning; it performs
one tiny read-only probe. The CLI never reads or prints credential files. Check that the local Codex
installation works under the same user and that configured model aliases are available.

If the requested reasoning effort is unsupported, the adapter tries one configured fallback. A second
failure is reported as exit 6; change the model/reasoning configuration or pass a supported explicit
override.

## Task is blocked

Read the latest transition, attempts, decisions, verification, and safe next command:

```bash
cxo task status <task-id>
cxo task logs <task-id> --tail 100
cxo task diff <task-id> --stat
```

After correcting configuration, budget, or source conditions, run `cxo task resume <task-id>` and the
reported next command. Resume intentionally fails if primary HEAD moved, the worktree registration or
branch changed, the diff is stale, verification is incompatible, or another process still owns the
task operation lock.

## Budget exhausted

Status shows phase/model usage and applied overrides. Resume only after choosing a profile or explicit
`--max-total-tokens`/`--max-agent-calls` value that admits the next bounded call. Do not retry identical
deterministic failures; new evidence is required.

## Source commit or knowledge is stale

Do not reset a user repository. Inspect its intended base, then run:

```bash
cxo project refresh <project>
cxo project inspect <project>
```

Existing task diagnosis remains commit-bound. Create/rediagnose at the intended current source rather
than bypassing the integrity error. Audit artifacts are unusable when affected evidence changed.

## Cleanup refuses a worktree or branch

Cleanup is intentionally conservative. Wait until the active phase releases its task lock. Completed
cleanup rejects a missing, escaped, or hash-mismatched persisted patch and any changed live diff.
Removing a cancelled/blocked worktree is explicit abandonment: the CLI captures a recovery patch and
marks the task terminal `failed`. Branch deletion is rejected if it contains unmerged commits; the CLI
never recommends force deletion. Without `--delete-branch`, worktree removal preserves its branch and
all saved state artifacts.

## A lock remains after a crash

Locks include owner PID and timestamp. A live or recently created lock is never stolen. After the
configured stale interval, a lock whose process no longer exists can be recovered on the next
operation. Do not manually delete broad state directories; preserve task reports and patches for
recovery.

## Logs seem incomplete

SDK and command logs have byte caps, while `task logs` also bounds returned records/characters. Use a
larger configured storage cap before a new run if needed. Hidden reasoning and recognized secrets are
always redacted and cannot be recovered through the CLI.
