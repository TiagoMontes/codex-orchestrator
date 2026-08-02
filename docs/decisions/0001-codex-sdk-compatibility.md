# ADR 0001: Codex SDK 0.146.0 compatibility boundary

Date: 2026-08-02

## Decision

Codex Orchestrator pins `@openai/codex-sdk` to `0.146.0` and isolates it behind `CodexRuntime`.
The installed SDK API was inspected before implementing the adapter.

The SDK supports reasoning efforts `minimal`, `low`, `medium`, `high`, and `xhigh`. The internal
`deepest` preset therefore maps to `xhigh`; `Ultra` is never used as a model identifier. A single
fallback to the next configured effort is permitted only when the runtime explicitly reports an
unsupported model/effort combination. The fallback is persisted as a compatibility event.

`runStreamed()` is always consumed. The adapter records bounded/redacted events, extracts the last
completed agent message, records actual `turn.completed` usage, calculates total tokens as input
plus output, and validates parsed JSON with Zod after schema-constrained generation.

Every thread explicitly sets the working directory, sandbox, `skipGitRepoCheck: false`, network
policy, disabled web search, `approvalPolicy: never`, and an empty additional-writable-directory
list. Major-phase thread rotation remains an application concern above the adapter.

## Published-package note

The SDK declaration references MCP content types supplied by its source-tree development
dependencies. `skipLibCheck` contains third-party declaration checking while application code
continues to compile under strict TypeScript. If a future compiler requires direct resolution,
`@modelcontextprotocol/sdk` will be added explicitly and recorded in a new decision.
