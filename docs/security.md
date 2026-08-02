# Security model

The orchestrator assumes raw feedback, registered repository contents, `AGENTS.md`, project skills,
model output, command output, and remote URLs are untrusted.

## Repository and filesystem safety

- Registration canonicalizes the Git root and records metadata without executing project code.
- Diagnosis, audit, exploration, and review snapshot primary HEAD/status and fail if they change.
- Production writes are confined to a state-owned Git worktree. Additional writable directories are
  never passed to the SDK.
- Safe-path resolution rejects parent traversal and canonical symlink escape for repository evidence,
  worktrees, logs, patches, instruction files, and skills.
- Task IDs and project IDs are restricted before they participate in state paths.
- Git argv and exit results are recorded; shell strings are not used for verification.

The CLI does not implement merge, push, force-push, reset, checkout replacement, or automatic branch
deletion. Cleanup requires explicit flags and exclusive task ownership. A completed dirty worktree is
removable only while its live diff equals the persisted hash-bound patch. Blocked/cancelled
abandonment first recaptures a recovery patch and makes the task terminal. Branch deletion receives a
second ancestry check and refuses unmerged commits.

## Codex runtime

Approval policy is always `never`. Web search, unrestricted filesystem access, and native Codex
subagents are disabled. Network defaults to false and requires an explicit per-execution override.
Every role keeps `skipGitRepoCheck` false.

The environment passed to the SDK and verification children is reduced to the configured allowlist.
Credential files are never inspected, copied, printed, or persisted. Remote URLs, bearer tokens,
common secret assignments, and command logs are redacted before persistence. Hidden reasoning events
are represented only by redacted metadata; reasoning text is never emitted.

SDK events and command logs have configured byte caps. CLI log records are bounded, control
characters and ANSI sequences are removed, and arbitrary user-supplied log paths are never accepted.
`task diff --patch` is the explicit path for displaying the complete hash-checked patch.

## Prompt injection resistance

Prompts label feedback and repository material as untrusted evidence. Repository instructions and
selected skills cannot relax sandbox, network, approval, path, budget, evidence, or verification
policy. Model claims must reference persisted evidence; instructions that request secrets,
out-of-scope writes, destructive Git, or policy changes are ignored by application enforcement.

Bundled skills cannot be shadowed by same-name project or user skills. Selected full-file and
instruction-body hashes are embedded in context packs and revalidated immediately before SDK calls.
User skills require explicit `CODEX_ORCHESTRATOR_ALLOW_USER_SKILLS=1` opt-in.

## Host limitations

The SDK sandbox controls model tooling, but deterministic verification is a local child process. The
runner provides literal argv, a sanitized environment, timeouts, cancellation, bounded logs, and the
task worktree cwd; it does not create an OS network namespace. Use host/container controls if test
commands must be unable to access a network.
