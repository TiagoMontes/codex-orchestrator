# Model routing

Routing is deterministic application logic, not a model choosing itself. It considers phase, task
type, risk signals, profile capabilities, prior deterministic failures, estimated call size, remaining
budget, and explicit overrides.

Default aliases are resolved at runtime:

| Work                             | Default alias | Reasoning |
| -------------------------------- | ------------- | --------- |
| normalization/classification     | `fast`        | low       |
| exploration/standard diagnosis   | `efficient`   | medium    |
| standard implementation          | `efficient`   | medium    |
| complex diagnosis/implementation | `capable`     | high      |
| independent review               | `capable`     | high      |
| critical review                  | `capable`     | deepest   |

The shipped aliases currently map to `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6`, but reports
always show the validated effective configuration. “Ultra” is not treated as a model. Internal
reasoning presets map to SDK efforts; `deepest` maps to `xhigh` with a configured `high` fallback.

Economy disallows capable-model and deepest-reasoning routes. Other profiles admit them only within
their budgets. Explicit `--model` and `--reasoning` overrides are validated, persisted, and visible.

Escalation occurs only after a failed or unresolved attempt with new evidence and enough budget for
the next call. The escalation decision itself is persisted. Repeating a failure signature without new
evidence blocks instead of spending another call.

Parallel reading is chosen only for independently partitioned modules, remains depth one and
read-only, and is limited by both global and profile reader caps. Native Codex subagents remain
disabled; the application owns coordination and the shared ledger.
