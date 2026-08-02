import type { Command } from "commander";
import type { ConfigService } from "../../application/configuration/config-service.js";
import type { TaskManager } from "../../application/tasks/task-service.js";
import { taskStatusSchema, type Task } from "../../domain/task/task.js";
import type { OutputWriter } from "../output.js";
import { writeResult } from "../output.js";
import type { TaskReporter } from "../../application/tasks/task-reporting-service.js";
import { parseCliValue } from "../validation.js";

export function registerTaskQueryCommands(
  task: Command,
  program: Command,
  tasks: TaskManager,
  config: ConfigService,
  output: OutputWriter,
  reporter?: TaskReporter,
): void {
  task
    .command("list")
    .option("--project <project>", "filter by project")
    .option("--status <status>", "filter by task status")
    .description("List durable tasks")
    .action(async (options: { project?: string; status?: string }) => {
      await config.load();
      const status =
        options.status === undefined
          ? undefined
          : parseCliValue(taskStatusSchema, options.status, "--status");
      const found = await tasks.list({
        ...(options.project === undefined ? {} : { project: options.project }),
        ...(status === undefined ? {} : { status }),
      });
      if (isJson(program)) {
        writeResult(output, { tasks: found }, true);
      } else if (found.length === 0) {
        output.write("No matching tasks.");
      } else {
        for (const item of found)
          output.write(`${item.id}\t${item.status}\t${item.risk}\t${item.title}`);
      }
    });

  task
    .command("inspect")
    .argument("<task-id>")
    .description("Show a normalized task")
    .action(async (taskId: string) => {
      await config.load();
      const found = await tasks.inspect(taskId);
      emitTask(program, output, found);
    });

  task
    .command("status")
    .argument("<task-id>")
    .description("Show task status and transition history")
    .action(async (taskId: string) => {
      await config.load();
      if (reporter !== undefined) {
        const report = await reporter.status(taskId);
        if (isJson(program)) {
          writeResult(output, report, true);
          return;
        }
        output.write(`Task: ${report.task.id} — ${report.task.title}`);
        output.write(`Status: ${report.state.status}; revision: ${report.task.revision}`);
        output.write(
          `Base: ${report.task.baseRef ?? "not selected"} @ ${report.task.baseCommit ?? "not pinned"}`,
        );
        output.write(
          report.task.worktree === undefined
            ? "Worktree: none"
            : `Worktree: ${report.task.worktree.path} (${report.task.worktree.branch})`,
        );
        output.write(
          `Attempts: ${report.attempts.length}; retries: ${report.retryCount}; threads: ${report.threads.length}`,
        );
        output.write(
          `Usage: ${report.usage.totals.totalTokens} tokens; calls: ${report.usage.totalCalls}`,
        );
        output.write(
          `Verification: ${report.artifacts.verification?.overallStatus ?? "not run"}; review: ${report.artifacts.review?.verdict ?? "not run"}`,
        );
        if (report.state.resumableFrom !== undefined) {
          output.write(`Resume boundary: ${report.state.resumableFrom}`);
        }
        for (const transition of report.state.transitions.slice(-5)) {
          output.write(
            `Transition: ${transition.previousState} -> ${transition.nextState} (${transition.reason})`,
          );
        }
        const diagnosis = report.artifacts.diagnosis;
        if (diagnosis !== undefined) {
          output.write(
            `Diagnosis: ${diagnosis.status}; ${diagnosis.rootCauses.map((cause) => cause.statement).join("; ") || diagnosis.nextAction}`,
          );
        }
        const diff = report.artifacts.diff;
        if (diff !== undefined)
          output.write(`Changed files: ${diff.changedFiles.join(", ") || "none"}`);
        for (const command of report.artifacts.verification?.commands ?? []) {
          output.write(`Check: ${command.name} — ${command.status}`);
        }
        for (const finding of report.artifacts.review?.findings ?? []) {
          output.write(`Finding [${finding.severity}]: ${finding.title}`);
        }
        for (const assessment of report.artifacts.review?.acceptanceCriteriaAssessment ?? []) {
          output.write(`Criterion ${assessment.criterionId}: ${assessment.status}`);
        }
        for (const usage of report.usageBreakdown) {
          output.write(
            `Usage ${usage.phase}/${usage.model}: ${usage.totalTokens} tokens in ${usage.calls} call(s)`,
          );
        }
        for (const decision of report.decisions.slice(-5)) {
          output.write(`Decision [${decision.kind}]: ${decision.summary}`);
        }
        output.write(
          `Integrity: artifacts valid; live diff ${report.integrity.liveDiffCurrent === undefined ? "not applicable" : report.integrity.liveDiffCurrent ? "current" : "stale"}`,
        );
        for (const limitation of report.limitations) output.write(`Limitation: ${limitation}`);
        if (report.nextCommand !== undefined) output.write(`Next: ${report.nextCommand}`);
        return;
      }
      const status = await tasks.status(taskId);
      if (isJson(program)) {
        writeResult(output, status, true);
      } else {
        output.write(`Task: ${status.task.id}`);
        output.write(`Status: ${status.state.status}`);
        output.write(`Transitions: ${status.state.transitions.length}`);
      }
    });
}

function emitTask(program: Command, output: OutputWriter, task: Task): void {
  if (isJson(program)) {
    writeResult(output, task, true);
    return;
  }
  output.write(`Task: ${task.id} — ${task.title}`);
  output.write(`Project: ${task.projectId}; type: ${task.type}; status: ${task.status}`);
  output.write(`Risk: ${task.risk}; profile: ${task.profile}`);
  output.write(`Acceptance criteria: ${task.acceptanceCriteria.length}`);
  output.write(`Original feedback: ${task.originalFeedbackPath}`);
}

function isJson(program: Command): boolean {
  return program.opts<{ json?: boolean }>().json ?? false;
}
