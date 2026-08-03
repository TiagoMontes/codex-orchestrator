# Task lifecycle

Tasks move through a persisted state machine:

```text
created -> normalizing -> ready-for-diagnosis -> diagnosing -> diagnosed
        -> worktree-preparing -> ready-for-implementation -> implementing
        -> verifying -> reviewing -> completed
                           ^          |
                           |          v
                           +------ correcting
```

Active nonterminal states may move to `blocked`, `cancelled`, or `failed`. `completed` and `failed`
are terminal. A blocked/cancelled document records the prior state as `resumableFrom`.

## Safe resume boundaries

`task resume` never jumps directly into an incomplete transient phase:

- intake interruption re-enters `normalizing`, retries the SDK call or uses its saved finalization
  plan, and reaches `ready-for-diagnosis` only after the structured task is validated;
- diagnosis interruption resumes at `ready-for-diagnosis`;
- worktree, implementation, verification, or correction interruption resumes at
  `ready-for-implementation`;
- review interruption resumes at `reviewing` only when the live diff and passing verification still
  match; an interrupted review correction is recovered as an implementation correction with the
  persisted focused findings.

Resume obtains task/project operation locks, so the old process must finish cancellation first. It
conservatively charges crash-interrupted reservations that belong to persisted running attempts and
releases only unattached pre-call reservations. It checks task/state synchronization, source commit,
primary HEAD, worktree registration and branch, base ancestry, diff hash, verification identity, and
verification-policy hash before changing state. Attempt and review-cycle counts come from durable
execution history and cannot be reset by restarting the CLI. Persisted validated phase checkpoints
are replayed without another model call only after their semantic inputs and live Git evidence still
match.

Every diagnosis runs in a unique disposable detached worktree at the task base commit. Only approved
focused verification commands may run there as reproduction, and each must leave the detached tree
clean. The primary checkout may begin dirty, but its exact HEAD/status snapshot must remain unchanged.

## Cancellation

`task cancel` uses revision compare-and-swap with bounded retry so a concurrent phase transition
cannot silently lose the request. Active services poll persisted state and combine it with caller
signals. SDK calls and verification children receive the linked abort signal. Attempts become
`cancelled`; started calls without actual usage are conservatively charged at their admitted maximum,
and the primary checkout remains unchanged.

## Verification and review

An implementer result never determines the diff. Git captures the real worktree patch relative to the
diagnosed base and hashes it. Approved verification argv run in order inside the fail-closed host
sandbox; each log, excerpt, status, and hash is persisted together with the effective command and
name-only environment-policy hash.
Cancellation terminates the active process group (and prevents the next command) while preserving
partial evidence.

The reviewer starts a fresh read-only thread against the exact diff. It must assess every required
criterion exactly once and bind findings to evidence/current changed files. Changes requested enter a
bounded writer/reviewer correction cycle. Only an approved current diff transitions to `completed`.

## Cleanup and project removal

Cleanup without flags is a dry run. A completed dirty worktree requires exact persisted-patch and
live-diff validation before explicit removal. Explicit removal from `blocked` or `cancelled` is treated
as abandonment: after exclusive ownership is proven, orphan attempts are finalized, a fresh recovery
patch is captured and hash-checked, the task transitions to terminal `failed`, and only then is the
worktree force-removed. Patches and reports remain in state. `--delete-branch` additionally refuses
commits not merged into primary HEAD.

Project removal is an explicit deletion of orchestrator registration/state only. It acquires the
project lock and every known task-operation lock, then refuses active tasks or registered task
worktrees. Once worktrees are safely cleaned, project task-index entries and project state are removed
without touching the target repository.
