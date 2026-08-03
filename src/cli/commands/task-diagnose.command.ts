import type { Command } from "commander";
import {
  executionProfileSchema,
  reasoningPresetSchema,
} from "../../application/configuration/config-schema.js";
import type {
  DiagnosisOverrides,
  TaskDiagnosisManager,
} from "../../application/tasks/task-diagnosis-service.js";
import { OrchestratorError } from "../../shared/errors.js";
import { parseCliValue } from "../validation.js";
import type { OutputWriter } from "../output.js";
import { codexProgressWriter, writeResult } from "../output.js";

export function registerTaskDiagnoseCommand(
  task: Command,
  program: Command,
  diagnosis: TaskDiagnosisManager,
  output: OutputWriter,
): void {
  task
    .command("diagnose")
    .argument("<task-id>")
    .option("--profile <profile>")
    .option("--model <model-id>")
    .option("--reasoning <preset>")
    .option("--max-total-tokens <number>")
    .option("--max-agent-calls <number>")
    .option("--parallel-readers <number>")
    .option("--allow-network", "explicitly enable network for this execution", false)
    .option("--base-ref <git-ref>")
    .option("--timeout <duration>")
    .description("Run bounded read-only diagnosis in a fresh Codex thread")
    .action(async (taskId: string, options: Record<string, string | boolean | undefined>) => {
      const json = program.opts<{ json?: boolean }>().json ?? false;
      if (!json) output.write("[diagnosis] preparing detached read-only worktree");
      const overrides: DiagnosisOverrides = {
        ...parseOverrides(options),
        ...(json ? {} : { progress: codexProgressWriter(output) }),
      };
      const report = await diagnosis.diagnose(taskId, overrides);
      if (json) {
        writeResult(output, report, true);
        return;
      }
      output.write(`Diagnosis: ${report.diagnosis.status}`);
      output.write(`Task: ${report.task.id}; source: ${report.diagnosis.sourceCommit}`);
      output.write(`Routing: ${report.modelDecision.model} / ${report.modelDecision.reasoning}`);
      output.write(`Reason: ${report.modelDecision.reason}`);
      output.write(
        `Evidence: ${report.evidence.length}; root causes: ${report.diagnosis.rootCauses.length}`,
      );
      output.write(`Usage: ${report.usage.totalTokens} tokens (${report.usage.source})`);
      output.write(`Next: ${report.diagnosis.nextAction}`);
    });
}

function parseOverrides(options: Record<string, string | boolean | undefined>): DiagnosisOverrides {
  return {
    ...(typeof options.profile === "string"
      ? { profile: parseCliValue(executionProfileSchema, options.profile, "--profile") }
      : {}),
    ...(typeof options.model === "string" ? { model: options.model } : {}),
    ...(typeof options.reasoning === "string"
      ? { reasoning: parseCliValue(reasoningPresetSchema, options.reasoning, "--reasoning") }
      : {}),
    ...(typeof options.maxTotalTokens === "string"
      ? { maxTotalTokens: positiveInteger(options.maxTotalTokens, "max-total-tokens") }
      : {}),
    ...(typeof options.maxAgentCalls === "string"
      ? { maxAgentCalls: positiveInteger(options.maxAgentCalls, "max-agent-calls") }
      : {}),
    ...(typeof options.parallelReaders === "string"
      ? { parallelReaders: nonnegativeInteger(options.parallelReaders, "parallel-readers") }
      : {}),
    ...(options.allowNetwork === true ? { allowNetwork: true } : {}),
    ...(typeof options.baseRef === "string" ? { baseRef: options.baseRef } : {}),
    ...(typeof options.timeout === "string" ? { timeoutMs: parseDuration(options.timeout) } : {}),
  };
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new OrchestratorError(`--${name} must be a positive integer`, { code: "CLI_INPUT" });
  }
  return parsed;
}

function nonnegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new OrchestratorError(`--${name} must be a nonnegative integer`, { code: "CLI_INPUT" });
  }
  return parsed;
}

function parseDuration(value: string): number {
  const match = /^(\d+)(ms|s|m)?$/u.exec(value);
  if (match === null) {
    throw new OrchestratorError("--timeout must look like 500ms, 30s, or 5m", {
      code: "CLI_INPUT",
    });
  }
  const amount = Number(match[1]);
  const multiplier = match[2] === "m" ? 60_000 : match[2] === "s" ? 1_000 : 1;
  return positiveInteger(String(amount * multiplier), "timeout");
}
