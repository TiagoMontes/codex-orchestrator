# Context and token governance

Every agent call passes admission control before it starts. The governing profile supplies one shared
task ceiling for total tokens and agent calls; parallel readers reserve from that same ledger rather
than receiving independent budgets.

## Context construction

Context packs are phase-specific. They include task and acceptance hashes, source/worktree commits,
instruction hashes, only selected skills, bounded evidence, a bounded relevant-file list, and the
output schema. Review additionally requires the exact patch, diff hash, and verification result.

Input size is estimated with a configurable safety multiplier. Evidence excerpts, failures, findings,
files, and patch material are capped. Full conversations and full logs are disabled. Crossing the hard
input limit blocks the phase before an SDK call.

## Admission and accounting

Before a call, `ContextBudgetManager` atomically reserves twice the projected input/output capacity
and two agent calls: the primary attempt plus either compatibility fallback or structured-output
repair. A successful call replaces the reservation with actual SDK usage. Failure and cancellation
release the reservation; safe resume clears crash-stale reservations while holding the operation lock.
No fallback/repair call starts unless its worst-case capacity was admitted.

The durable usage ledger records phase, model, reasoning, thread, worker, calls, token fields, and
whether usage was actual or estimated. `task status` reports totals and phase/model breakdowns.
Project audit has a separate explicit per-run worst-case ceiling because it is project knowledge
rather than a task phase.

## Parallel workers and memory

Project memory is commit-scoped audit knowledge. Task memory contains the normalized task,
transitions, evidence, attempts, decisions, usage, diagnosis, diff, verification, and review. Agent
memory is a bounded phase context pack, never the whole conversation or repository.

When `--parallel-readers` is requested, the planner launches workers only for independent report or
file scopes. Each gets a worker ID, read-only context pack, fresh thread, per-worker token cap, and no
nested-agent permission. Reservations are atomic against the one parent ledger. Only validated,
deduplicated evidence and bounded summaries reach the main phase.

## Bounded loops

Profiles independently cap diagnosis attempts, implementation attempts, review cycles, turns per
thread, parallel readers, agent calls, and total tokens. Implementation retry requires a new
deterministic failure signature. Repeated signatures, unchanged evidence, source movement, exhausted
budget, cancellation, or a reached limit stop the loop.

The MVP starts a fresh thread for every major phase and bounded retry; it does not carry an unbounded
same-phase conversation. The rotation policy also rejects future continuation after the turn cap or a
context threshold. Every new pack retains validated summaries, confirmed evidence, current failures,
and integrity hashes rather than raw conversation history.

## Profiles

- `economy`: 50k task tokens, 5 calls, one diagnosis/implementation/review cycle.
- `balanced`: 120k tokens, 8 calls, bounded retries and up to two readers.
- `quality`: 250k tokens, 12 calls, deeper reasoning and up to three readers.
- `critical`: 400k tokens, 15 calls, the highest bounded review/attempt limits.

Overrides can lower or raise a run's configured ceiling, but admission, profile capability rules, and
remaining budget still apply. All overrides and serial/parallel decisions are persisted.
