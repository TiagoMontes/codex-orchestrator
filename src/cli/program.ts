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
import type { TaskDiagnosisManager } from "../application/tasks/task-diagnosis-service.js";
import { TaskDiagnosisService } from "../application/tasks/task-diagnosis-service.js";
import { CodexSdkRuntime } from "../infrastructure/codex/codex-sdk-runtime.js";
import type { CodexRuntime } from "../infrastructure/codex/codex-runtime.js";
import { UsageFileRepository } from "../infrastructure/persistence/usage-file-repository.js";
import { DiagnosisFileRepository } from "../infrastructure/persistence/diagnosis-file-repository.js";
import { EvidenceFileRepository } from "../infrastructure/persistence/evidence-file-repository.js";
import { ExecutionFileRepository } from "../infrastructure/persistence/execution-file-repository.js";
import { DecisionFileRepository } from "../infrastructure/persistence/decision-file-repository.js";
import { registerTaskDiagnoseCommand } from "./commands/task-diagnose.command.js";
import type { TaskRunner } from "../application/tasks/task-run-service.js";
import { TaskRunService } from "../application/tasks/task-run-service.js";
import { TaskWorktreeService } from "../application/tasks/task-worktree-service.js";
import { VerificationFileRepository } from "../infrastructure/persistence/verification-file-repository.js";
import { registerTaskRunCommand } from "./commands/task-run.command.js";
import type { TaskReviewer } from "../application/tasks/task-review-service.js";
import { TaskReviewService } from "../application/tasks/task-review-service.js";
import { ReviewFileRepository } from "../infrastructure/persistence/review-file-repository.js";
import { registerTaskReviewCommand } from "./commands/task-review.command.js";

export type ProgramDependencies = {
  output?: OutputWriter;
  configService?: ConfigService;
  doctorService?: DoctorRunner;
  projectService?: ProjectManager;
  taskService?: TaskManager;
  taskDiagnosisService?: TaskDiagnosisManager;
  taskRunService?: TaskRunner;
  taskReviewService?: TaskReviewer;
  codexRuntime?: CodexRuntime;
};

export function createProgram(dependencies: ProgramDependencies = {}): Command {
  const output = dependencies.output ?? consoleOutput;
  const configService = dependencies.configService ?? new ConfigService();
  const doctorService = dependencies.doctorService ?? new DoctorService(configService);
  const projectService =
    dependencies.projectService ??
    new ProjectService(new ProjectFileRepository(configService.paths));
  const taskRepository = new TaskFileRepository(configService.paths);
  const taskService =
    dependencies.taskService ??
    new TaskService(taskRepository, projectService, new DeterministicTaskNormalizer());
  const codexRuntime = dependencies.codexRuntime ?? new CodexSdkRuntime();
  const usageRepository = new UsageFileRepository(configService.paths);
  const diagnosisRepository = new DiagnosisFileRepository(configService.paths);
  const evidenceRepository = new EvidenceFileRepository(configService.paths);
  const executionRepository = new ExecutionFileRepository(configService.paths);
  const decisionRepository = new DecisionFileRepository(configService.paths);
  const verificationRepository = new VerificationFileRepository(configService.paths);
  const reviewRepository = new ReviewFileRepository(configService.paths);
  const taskDiagnosisService =
    dependencies.taskDiagnosisService ??
    new TaskDiagnosisService(
      configService,
      configService.paths,
      taskRepository,
      projectService,
      codexRuntime,
      usageRepository,
      diagnosisRepository,
      evidenceRepository,
      executionRepository,
      decisionRepository,
    );
  const taskWorktreeService = new TaskWorktreeService(
    configService.paths,
    taskRepository,
    projectService,
    diagnosisRepository,
  );
  const taskRunService =
    dependencies.taskRunService ??
    new TaskRunService(
      configService,
      configService.paths,
      taskRepository,
      projectService,
      taskWorktreeService,
      codexRuntime,
      usageRepository,
      diagnosisRepository,
      evidenceRepository,
      executionRepository,
      decisionRepository,
      verificationRepository,
    );
  const taskReviewService =
    dependencies.taskReviewService ??
    new TaskReviewService(
      configService,
      configService.paths,
      taskRepository,
      projectService,
      codexRuntime,
      usageRepository,
      diagnosisRepository,
      evidenceRepository,
      executionRepository,
      decisionRepository,
      verificationRepository,
      reviewRepository,
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
  registerTaskDiagnoseCommand(task, program, taskDiagnosisService, output);
  registerTaskRunCommand(task, program, taskRunService, output);
  registerTaskReviewCommand(task, program, taskReviewService, output);

  return program;
}

function commanderErrorToDomainError(error: CommanderError): OrchestratorError {
  return new OrchestratorError(error.message, {
    code: "CLI_INPUT",
    cause: error,
  });
}
