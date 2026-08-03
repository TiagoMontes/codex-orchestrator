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
- Git argv and exit results are recorded in configured-cap, redacted `runs/git.jsonl` logs at global,
  project, or task scope. Records include every available task, phase, execution, and thread
  correlation identifier; shell strings are not used for verification.
- Deterministic verification fails closed behind a host sandbox. macOS uses Seatbelt to deny network
  and writes outside the task worktree and a private scratch directory. Linux requires bubblewrap,
  exposes only allowlisted read-only system/toolchain roots plus those two writable locations, and
  creates fresh PID, proc, IPC, UTS, and network namespaces. Real home, host `/proc`, temporary files,
  runtime sockets, and other repository paths are absent. Unsupported hosts or missing sandbox
  helpers produce blocked verification without starting the configured command.

The CLI does not implement merge, push, force-push, reset, checkout replacement, or automatic branch
deletion. Cleanup requires explicit flags and exclusive task ownership. A completed dirty worktree is
removable only while its live diff equals the persisted hash-bound patch. Blocked/cancelled
abandonment first recaptures a recovery patch and makes the task terminal. Branch deletion receives a
second ancestry check and refuses unmerged commits.

## Codex runtime

Approval policy is always `never`. Web search, unrestricted filesystem access, and native Codex
subagents are disabled. Network defaults to false and requires an explicit per-execution override.
Every role keeps `skipGitRepoCheck` false.

The environment passed to the SDK and verification children is reduced to the global allowlist plus
name-only per-project entries from state-owned `project-config.yaml`. Values are never persisted.
Sensitive-looking names require an explicit name-only exception and emit a warning; loader/startup
variables remain denied even if listed.
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

The SDK sandbox controls model tooling; deterministic verification is separately confined by host
primitives. The runner supplies literal argv, a sanitized environment with synthetic `HOME` and
`TMPDIR`, timeouts, cancellation, bounded logs, and task-worktree-only writes. It starts each command
in a process group and terminates the group on timeout or cancellation. A normally exiting command
that leaves descendants is treated as blocked and the group is killed. A second hard deadline closes
inherited pipes and returns a blocked result rather than waiting indefinitely.

On macOS, the minimal Seatbelt profile does not import `system.sb`; it permits only an enumerated set
of read-only runtime sysctls and narrow toolchain roots. Broad `/usr` and host configuration trees
are excluded; Homebrew's OpenSSL access is one literal runtime configuration file, not its directory.
A deliberately re-sessioned daemon can leave the original Unix process group. It continues under the
inherited Seatbelt network/filesystem restrictions, but the worktree remains an allowed write root,
so a hostile escaped daemon could mutate it after the runner returns. On
Linux, only a root-owned, non-group/world-writable bubblewrap binary whose ancestors are trusted and
whose canonical path is in a fixed system location is accepted. Linux `/opt` toolchains,
home-installed toolchains, linked-worktree Git metadata, or dependencies reached through symlinks
outside the worktree are hidden and may therefore need a system installation or an outer disposable
container. These mechanisms reduce
exposure but do not turn arbitrary third-party tests into trusted code; use a disposable
VM/container as an additional boundary for hostile repositories.
