import type { AgentRole, CodexProgressObserver } from "../infrastructure/codex/codex-runtime.js";

export interface OutputWriter {
  write(message: string): void;
  writeError(message: string): void;
}

export function codexProgressWriter(writer: OutputWriter): CodexProgressObserver {
  return (event) => {
    const phase = progressPhase(event.role);
    if (event.kind === "thread-started") {
      writer.write(`[${phase}] thread started`);
    } else if (event.kind === "command-completed") {
      writer.write(
        `[${phase}] command ${event.status}${event.exitCode === undefined ? "" : `; exit ${event.exitCode}`}`,
      );
    } else if (event.kind === "tool-completed") {
      writer.write(`[${phase}] tool ${event.server}/${event.tool} ${event.status}`);
    } else if (event.kind === "turn-completed") {
      writer.write(`[${phase}] usage ${event.usage.totalTokens} tokens (${event.usage.source})`);
    } else if (event.kind === "output-repair") {
      writer.write(`[${phase}] validating structured output with one bounded repair`);
    } else if (event.kind === "reasoning-fallback") {
      writer.write(`[${phase}] applying configured reasoning compatibility fallback`);
    } else if (event.kind === "runtime-timeout") {
      writer.write(`[${phase}] runtime timed out`);
    } else if (event.kind === "runtime-cancelled") {
      writer.write(`[${phase}] runtime cancelled`);
    } else {
      writer.write(`[${phase}] turn failed`);
    }
  };
}

export const consoleOutput: OutputWriter = {
  write: (message) => process.stdout.write(`${message}\n`),
  writeError: (message) => process.stderr.write(`${message}\n`),
};

export function writeResult(writer: OutputWriter, value: unknown, json: boolean): void {
  if (json) {
    writer.write(JSON.stringify(value, null, 2));
    return;
  }

  if (typeof value === "string") {
    writer.write(value);
    return;
  }

  writer.write(JSON.stringify(value, null, 2));
}

function progressPhase(role: AgentRole): string {
  const phases: Record<AgentRole, string> = {
    normalizer: "normalization",
    "repository-explorer": "exploration",
    diagnostician: "diagnosis",
    implementer: "implementation",
    reviewer: "review",
    "audit-mapper": "audit",
    corrector: "correction",
    "read-worker": "exploration",
  };
  return phases[role];
}
