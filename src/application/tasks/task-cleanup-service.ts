import type { TaskWorktreeService } from "./task-worktree-service.js";
import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";
import { FileLockManager } from "../../infrastructure/persistence/file-lock.js";
import { OrchestratorError } from "../../shared/errors.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import { DiffService } from "../../infrastructure/git/diff-service.js";
import { TaskStateMachine } from "../../orchestration/engine/state-machine.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";

export type TaskCleanupReport = {
  taskId: string;
  dryRun: boolean;
  hasWorktree: boolean;
  worktreePath?: string;
  branch?: string;
  removed: boolean;
  branchDeleted: boolean;
  abandonsTask: boolean;
  reconciledExecutions: number;
  recoveryPatchPath?: string;
};

export interface TaskCleaner {
  cleanup(
    taskId: string,
    options?: { removeWorktree?: boolean; deleteBranch?: boolean },
  ): Promise<TaskCleanupReport>;
}

export class TaskCleanupService implements TaskCleaner {
  private readonly operationLocks: FileLockManager;
  private readonly stateMachine = new TaskStateMachine();

  constructor(
    private readonly paths: StatePaths,
    private readonly tasks: TaskFileRepository,
    private readonly executions: ExecutionFileRepository,
    private readonly worktrees: TaskWorktreeService,
    private readonly clock: Clock = systemClock,
  ) {
    this.operationLocks = new FileLockManager(paths.locksDirectory);
  }

  async cleanup(
    taskId: string,
    options: { removeWorktree?: boolean; deleteBranch?: boolean } = {},
  ): Promise<TaskCleanupReport> {
    let task = await this.tasks.get(taskId);
    if (options.deleteBranch === true && options.removeWorktree !== true) {
      throw new OrchestratorError("--delete-branch requires --remove-worktree", {
        code: "CLI_INPUT",
      });
    }
    const abandonsTask = task.status === "blocked" || task.status === "cancelled";
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
        abandonsTask,
        reconciledExecutions: 0,
      };
    }

    const operationLock = await this.operationLocks.acquire(`task-operation:${taskId}`);
    try {
      task = await this.tasks.get(taskId);
      let state = await this.tasks.getState(taskId);
      if (task.worktree === undefined) {
        throw new OrchestratorError(`Task ${taskId} has no worktree to remove`, {
          code: "TASK_STATE",
        });
      }
      if (!["completed", "failed", "blocked", "cancelled"].includes(task.status)) {
        throw new OrchestratorError("Task cleanup is unsafe while work may still be active", {
          code: "TASK_STATE",
          resumable: true,
          nextCommand: `cxo task cancel ${taskId}`,
        });
      }

      const attempts = await this.executions.list(task.projectId, task.id);
      const running = attempts.filter((attempt) => attempt.status === "running");
      if (task.status === "completed" && running.length > 0) {
        throw new OrchestratorError("Completed task has an inconsistent running execution", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const timestamp = isoNow(this.clock);
      for (const attempt of running) {
        await this.executions.save(task.projectId, {
          ...attempt,
          completedAt: timestamp,
          status: "failed",
          error: {
            name: "OrchestratorError",
            message: "Orphaned execution reconciled during explicit task abandonment",
            code: "TASK_STATE",
            resumable: false,
          },
        });
      }

      const diffService = new DiffService(this.paths);
      let recoveryPatchPath: string;
      if (task.status === "completed") {
        const diff = await diffService.read(task.projectId, task.id);
        if (
          task.baseCommit === undefined ||
          diff.sourceCommit !== task.baseCommit ||
          diff.baseCommit !== task.baseCommit
        ) {
          throw new OrchestratorError("Completed cleanup diff is not bound to the task source", {
            code: "CONTEXT_INTEGRITY",
          });
        }
        await diffService.readPersistedPatch(diff, task.projectId, task.id);
        await diffService.assertCurrent(diff, task.worktree.path);
        recoveryPatchPath = diff.patchPath;
      } else {
        if (task.baseCommit === undefined) {
          throw new OrchestratorError(
            "Task cleanup cannot capture a recovery patch without a base",
            {
              code: "CONTEXT_INTEGRITY",
            },
          );
        }
        const recovery = await diffService.capture({
          projectId: task.projectId,
          taskId: task.id,
          worktreePath: task.worktree.path,
          sourceCommit: task.baseCommit,
          baseCommit: task.baseCommit,
        });
        await diffService.readPersistedPatch(recovery, task.projectId, task.id);
        await diffService.assertCurrent(recovery, task.worktree.path);
        recoveryPatchPath = recovery.patchPath;
      }

      if (task.status === "blocked" || task.status === "cancelled") {
        state = this.stateMachine.transition(state, {
          nextState: "failed",
          timestamp,
          reason: "User explicitly abandoned the task worktree after recovery-patch capture",
          actor: "user",
        });
        task = {
          ...task,
          status: "failed",
          revision: task.revision + 1,
          updatedAt: timestamp,
        };
        await this.tasks.update(task, state);
      }

      const report = await this.worktrees.cleanup(taskId, {
        force: true,
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
        abandonsTask,
        reconciledExecutions: running.length,
        recoveryPatchPath,
      };
    } finally {
      await operationLock.release();
    }
  }
}
