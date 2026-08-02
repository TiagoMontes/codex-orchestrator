import type { Command } from "commander";
import {
  executionProfileSchema,
  reasoningPresetSchema,
} from "../../application/configuration/config-schema.js";
import type {
  TaskReviewer,
  TaskReviewOverrides,
} from "../../application/tasks/task-review-service.js";
import { OrchestratorError } from "../../shared/errors.js";
import { parseCliValue } from "../validation.js";
import type { OutputWriter } from "../output.js";
import { writeResult } from "../output.js";

export function registerTaskReviewCommand(
  task: Command,
  program: Command,
  reviewer: TaskReviewer,
  output: OutputWriter,
): void {
  task
    .command("review")
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
    .description("Run fresh independent review with bounded correction cycles")
    .action(async (taskId: string, options: Record<string, string | boolean | undefined>) => {
      const report = await reviewer.review(taskId, parseOverrides(options));
      if (program.opts<{ json?: boolean }>().json ?? false) {
        writeResult(output, report, true);
        return;
      }
      const finalReview = report.reviews.at(-1);
      output.write(`Task: ${report.task.id}; status: ${report.task.status}`);
      output.write(`Review: ${finalReview?.verdict ?? "none"}`);
      output.write(`Reviewed diff: ${finalReview?.reviewedDiffHash ?? "none"}`);
      output.write(
        `Review cycles: ${report.reviews.length}; corrections: ${report.corrections.length}`,
      );
      output.write(`Findings: ${finalReview?.findings.length ?? 0}`);
      for (const finding of finalReview?.findings ?? []) {
        output.write(`  [${finding.severity}] ${finding.title}`);
      }
      output.write(`Verification: ${report.verification.overallStatus}`);
      output.write(
        `Usage: ${report.usage.totals.totalTokens} tokens across ${report.usage.totalCalls} agent call(s)`,
      );
      output.write(`Next: cxo task inspect ${report.task.id}`);
    });
}

function parseOverrides(
  options: Record<string, string | boolean | undefined>,
): TaskReviewOverrides {
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
