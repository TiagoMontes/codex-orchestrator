import { Command } from "commander";
import type { CommanderError } from "commander";
import type { OutputWriter } from "./output.js";
import { consoleOutput } from "./output.js";
import { OrchestratorError } from "../shared/errors.js";
import { ConfigService } from "../application/configuration/config-service.js";
import { registerConfigCommand } from "./commands/config.command.js";
import type { DoctorRunner } from "../application/doctor/doctor-types.js";
import { DoctorService } from "../application/doctor/doctor-service.js";
import { registerDoctorCommand } from "./commands/doctor.command.js";
import type { ProjectManager } from "../application/projects/project-service.js";
import { ProjectService } from "../application/projects/project-service.js";
import { ProjectFileRepository } from "../infrastructure/persistence/project-file-repository.js";
import { registerProjectCommands } from "./commands/project.command.js";
import type { TaskManager } from "../application/tasks/task-service.js";
import { TaskService } from "../application/tasks/task-service.js";
import { DeterministicTaskNormalizer } from "../application/tasks/deterministic-task-normalizer.js";
import { TaskFileRepository } from "../infrastructure/persistence/task-file-repository.js";
import { registerTaskCreateCommand } from "./commands/task-create.command.js";
import { registerTaskQueryCommands } from "./commands/task-query.command.js";

export type ProgramDependencies = {
  output?: OutputWriter;
  configService?: ConfigService;
  doctorService?: DoctorRunner;
  projectService?: ProjectManager;
  taskService?: TaskManager;
};

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const output = dependencies.output ?? consoleOutput;
  const configService = dependencies.configService ?? new ConfigService();
  const doctorService = dependencies.doctorService ?? new DoctorService(configService);
  const projectService =
    dependencies.projectService ??
    new ProjectService(new ProjectFileRepository(configService.paths));
  const taskService =
    dependencies.taskService ??
    new TaskService(
      new TaskFileRepository(configService.paths),
      projectService,
      new DeterministicTaskNormalizer(),
    );
  const program = new Command();

  program
    .name("cxo")
    .description("Safely orchestrate Codex against external Git repositories")
    .version("0.1.0")
    .option("--debug", "show stack traces for errors", false)
    .option("--json", "emit machine-readable JSON", false)
    .configureOutput({
      writeOut: (message) => output.write(message.trimEnd()),
      writeErr: (message) => output.writeError(message.trimEnd()),
    })
    .showHelpAfterError()
    .exitOverride((error) => {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
        return;
      }
      throw commanderErrorToDomainError(error);
    });

  registerConfigCommand(program, configService, output);
  registerDoctorCommand(program, doctorService, output);
  registerProjectCommands(program, projectService, configService, output);
  const task = program.command("task").description("Create and orchestrate durable tasks");
  registerTaskCreateCommand(task, program, taskService, configService, output);
  registerTaskQueryCommands(task, program, taskService, configService, output);

  return program;
}

function commanderErrorToDomainError(error: CommanderError): OrchestratorError {
  return new OrchestratorError(error.message, {
    code: "CLI_INPUT",
    cause: error,
  });
}
