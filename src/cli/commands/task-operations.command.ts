import type { Command } from "commander";
import type { ConfigService } from "../../application/configuration/config-service.js";
import type { TaskCleaner } from "../../application/tasks/task-cleanup-service.js";
import type { TaskController } from "../../application/tasks/task-control-service.js";
import type { TaskReporter } from "../../application/tasks/task-reporting-service.js";
import { executionPhaseSchema } from "../../domain/execution/execution.js";
import { OrchestratorError } from "../../shared/errors.js";
import type { OutputWriter } from "../output.js";
import { writeResult } from "../output.js";
import { parseCliValue } from "../validation.js";

export function registerTaskOperationCommands(
  task: Command,
  program: Command,
  config: ConfigService,
  reporter: TaskReporter,
  controller: TaskController,
  cleaner: TaskCleaner,
  output: OutputWriter,
): void {
  task
    .command("diff")
    .argument("<task-id>")
    .option("--stat", "include the persisted diff stat", false)
    .option("--patch", "include the exact persisted patch", false)
    .description("Show the verified, hash-checked task diff")
    .action(async (taskId: string, options: { stat?: boolean; patch?: boolean }) => {
      await config.load();
      const report = await reporter.diff(taskId, options);
      if (isJson(program)) {
        writeResult(output, report, true);
        return;
      }
      output.write(`Diff: ${report.diff.diffHash}`);
      output.write(`Source: ${report.diff.sourceCommit}; live: ${report.live}`);
      output.write(`Files: ${report.diff.changedFiles.join(", ") || "none"}`);
      if (report.stat !== undefined) output.write(report.stat);
      if (report.patch !== undefined) output.write(report.patch);
    });

  task
    .command("logs")
    .argument("<task-id>")
    .option("--phase <phase>")
    .option("--tail <n>", "maximum records, from 1 through 1000", "50")
    .description("Show bounded redacted agent and verification logs")
    .action(async (taskId: string, options: { phase?: string; tail: string }) => {
      await config.load();
      const tail = Number(options.tail);
      if (!Number.isInteger(tail)) {
        throw new OrchestratorError("--tail must be an integer", { code: "CLI_INPUT" });
      }
      const report = await reporter.logs(taskId, {
        ...(options.phase === undefined
          ? {}
          : { phase: parseCliValue(executionPhaseSchema, options.phase, "--phase") }),
        tail,
      });
      if (isJson(program)) {
        writeResult(output, report, true);
        return;
      }
      if (report.records.length === 0) {
        output.write("No matching log records.");
        return;
      }
      for (const record of report.records) {
        output.write(`[${record.phase}/${record.source}] ${record.line}`);
      }
    });

  task
    .command("resume")
    .argument("<task-id>")
    .description("Move a blocked or cancelled task to its validated safe boundary")
    .action(async (taskId: string) => {
      await config.load();
      const report = await controller.resume(taskId);
      if (isJson(program)) writeResult(output, report, true);
      else {
        output.write(`Resumed ${taskId} to ${report.state.status}`);
        if (report.nextCommand !== undefined) output.write(`Next: ${report.nextCommand}`);
      }
    });

  task
    .command("cancel")
    .argument("<task-id>")
    .description("Persist a cancellation request and abort an active phase")
    .action(async (taskId: string) => {
      await config.load();
      const report = await controller.cancel(taskId);
      if (isJson(program)) writeResult(output, report, true);
      else output.write(`${report.idempotent ? "Already cancelled" : "Cancelled"}: ${taskId}`);
    });

  task
    .command("cleanup")
    .argument("<task-id>")
    .option(
      "--remove-worktree",
      "remove an inactive task worktree after preserving and validating its recovery patch",
      false,
    )
    .option("--delete-branch", "also delete the branch after merged-ancestry checks", false)
    .description("Inspect or explicitly clean safe task worktree resources")
    .action(
      async (taskId: string, options: { removeWorktree?: boolean; deleteBranch?: boolean }) => {
        await config.load();
        const report = await cleaner.cleanup(taskId, options);
        if (isJson(program)) writeResult(output, report, true);
        else if (report.dryRun) {
          output.write(
            report.hasWorktree
              ? `Dry run: worktree ${report.worktreePath}; pass --remove-worktree to remove it safely${report.abandonsTask ? " and mark the task failed" : ""}`
              : "Dry run: task has no worktree",
          );
        } else {
          output.write(`Removed worktree ${report.worktreePath}`);
          if (report.recoveryPatchPath !== undefined) {
            output.write(`Recovery patch: ${report.recoveryPatchPath}`);
          }
          output.write(`Branch deleted: ${report.branchDeleted}`);
        }
      },
    );
}

function isJson(program: Command): boolean {
  return program.opts<{ json?: boolean }>().json ?? false;
}
