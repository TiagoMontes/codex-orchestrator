import type { TaskWorktreeService } from "./task-worktree-service.js";
import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";
import { OrchestratorError } from "../../shared/errors.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import { DiffService } from "../../infrastructure/git/diff-service.js";

export type TaskCleanupReport = {
  taskId: string;
  dryRun: boolean;
  hasWorktree: boolean;
  worktreePath?: string;
  branch?: string;
  removed: boolean;
  branchDeleted: boolean;
};

export interface TaskCleaner {
  cleanup(
    taskId: string,
    options?: { removeWorktree?: boolean; deleteBranch?: boolean },
  ): Promise<TaskCleanupReport>;
}

export class TaskCleanupService implements TaskCleaner {
  constructor(
    private readonly paths: StatePaths,
    private readonly tasks: TaskFileRepository,
    private readonly executions: ExecutionFileRepository,
    private readonly worktrees: TaskWorktreeService,
  ) {}

  async cleanup(
    taskId: string,
    options: { removeWorktree?: boolean; deleteBranch?: boolean } = {},
  ): Promise<TaskCleanupReport> {
    const task = await this.tasks.get(taskId);
    if (options.deleteBranch === true && options.removeWorktree !== true) {
      throw new OrchestratorError("--delete-branch requires --remove-worktree", {
        code: "CLI_INPUT",
      });
    }
    if (options.removeWorktree !== true) {
      return {
        taskId,
        dryRun: true,
        hasWorktree: task.worktree !== undefined,
        ...(task.worktree === undefined
          ? {}
          : { worktreePath: task.worktree.path, branch: task.worktree.branch }),
        removed: false,
        branchDeleted: false,
      };
    }
    if (task.worktree === undefined) {
      throw new OrchestratorError(`Task ${taskId} has no worktree to remove`, {
        code: "TASK_STATE",
      });
    }
    if (
      !["completed", "failed"].includes(task.status) ||
      (await this.executions.list(task.projectId, task.id)).some(
        (attempt) => attempt.status === "running",
      )
    ) {
      throw new OrchestratorError("Task cleanup is unsafe while work may still be active", {
        code: "TASK_STATE",
        resumable: true,
      });
    }
    if (task.status === "completed") {
      const diff = await new DiffService(this.paths).read(task.projectId, task.id);
      await new DiffService(this.paths).assertCurrent(diff, task.worktree.path);
    }
    const report = await this.worktrees.cleanup(taskId, {
      force: task.status === "completed",
      deleteBranch: options.deleteBranch ?? false,
    });
    return {
      taskId,
      dryRun: false,
      hasWorktree: true,
      worktreePath: report.path,
      branch: report.branch,
      removed: true,
      branchDeleted: report.branchDeleted,
    };
  }
}
