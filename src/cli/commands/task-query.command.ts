import type { Command } from "commander";
import type { ConfigService } from "../../application/configuration/config-service.js";
import type { TaskManager } from "../../application/tasks/task-service.js";
import { taskStatusSchema, type Task } from "../../domain/task/task.js";
import type { OutputWriter } from "../output.js";
import { writeResult } from "../output.js";

export function registerTaskQueryCommands(
  task: Command,
  program: Command,
  tasks: TaskManager,
  config: ConfigService,
  output: OutputWriter,
): void {
  task
    .command("list")
    .option("--project <project>", "filter by project")
    .option("--status <status>", "filter by task status")
    .description("List durable tasks")
    .action(async (options: { project?: string; status?: string }) => {
      await config.load();
      const status =
        options.status === undefined ? undefined : taskStatusSchema.parse(options.status);
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
