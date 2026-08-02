import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { executionProfileSchema } from "../../application/configuration/config-schema.js";
import type { ConfigService } from "../../application/configuration/config-service.js";
import type { TaskManager } from "../../application/tasks/task-service.js";
import { OrchestratorError } from "../../shared/errors.js";
import type { OutputWriter } from "../output.js";
import { writeResult } from "../output.js";

export function registerTaskCreateCommand(
  task: Command,
  program: Command,
  tasks: TaskManager,
  configService: ConfigService,
  output: OutputWriter,
): void {
  task
    .command("create")
    .requiredOption("--project <project>", "project ID or unique name")
    .option("--from <file>", "read raw Markdown feedback from a file")
    .option("--stdin", "read raw feedback from standard input", false)
    .option("--profile <profile>", "economy, balanced, quality, or critical")
    .description("Preserve and normalize raw feedback into a durable task")
    .action(
      async (options: { project: string; from?: string; stdin: boolean; profile?: string }) => {
        if ((options.from === undefined) === !options.stdin) {
          throw new OrchestratorError("Choose exactly one of --from or --stdin", {
            code: "CLI_INPUT",
          });
        }
        const config = await configService.load();
        const profile = executionProfileSchema.parse(options.profile ?? config.defaultProfile);
        const feedback =
          options.from === undefined
            ? await readStandardInput()
            : await readFile(options.from, "utf8");
        const result = await tasks.create({ project: options.project, feedback, profile });
        if (isJson(program)) {
          writeResult(output, result, true);
          return;
        }
        output.write(`Created ${result.task.id}: ${result.task.title}`);
        output.write(
          `Status: ${result.task.status}; risk: ${result.task.risk}; profile: ${result.task.profile}`,
        );
        output.write(`Original feedback: ${result.task.originalFeedbackPath}`);
        if (result.childTasks.length > 0) {
          output.write(
            `Child task drafts: ${result.childTasks.map((child) => child.id).join(", ")}`,
          );
        }
      },
    );
}

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > 5_000_000) {
      throw new OrchestratorError("Standard input exceeds the 5 MB intake limit", {
        code: "CLI_INPUT",
      });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isJson(program: Command): boolean {
  return program.opts<{ json?: boolean }>().json ?? false;
}
