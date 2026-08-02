import type { DiagnosisFileRepository } from "../../infrastructure/persistence/diagnosis-file-repository.js";
import type { VerificationFileRepository } from "../../infrastructure/persistence/verification-file-repository.js";
import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import type { ProjectManager } from "../projects/project-service.js";
import { DiffService } from "../../infrastructure/git/diff-service.js";
import { GitClient } from "../../infrastructure/git/git-client.js";
import { WorktreeManager } from "../../infrastructure/git/worktree-manager.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import type { Task, TaskStatus } from "../../domain/task/task.js";
import type { TaskStateDocument } from "../../domain/task/task-state.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError } from "../../shared/errors.js";
import { TaskStateMachine } from "../../orchestration/engine/state-machine.js";
import { FileLockManager } from "../../infrastructure/persistence/file-lock.js";
import type { UsageFileRepository } from "../../infrastructure/persistence/usage-file-repository.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";

export type TaskControlReport = {
  task: Task;
  state: TaskStateDocument;
  nextCommand?: string;
  idempotent: boolean;
};

export interface TaskController {
  cancel(taskId: string): Promise<TaskControlReport>;
  resume(taskId: string): Promise<TaskControlReport>;
}

export interface TaskNormalizationResumer {
  resumeNormalization(taskId: string): Promise<{ task: Task }>;
}

export class TaskControlService implements TaskController {
  private readonly stateMachine = new TaskStateMachine();
  private readonly git = new GitClient();
  private readonly operationLocks: FileLockManager;

  constructor(
    private readonly paths: StatePaths,
    private readonly tasks: TaskFileRepository,
    private readonly projects: ProjectManager,
    private readonly diagnoses: DiagnosisFileRepository,
    private readonly verification: VerificationFileRepository,
    private readonly clock: Clock = systemClock,
    private readonly normalizationResumer?: TaskNormalizationResumer,
    private readonly usage?: UsageFileRepository,
    private readonly executions?: ExecutionFileRepository,
  ) {
    this.operationLocks = new FileLockManager(paths.locksDirectory);
  }

  async cancel(taskId: string): Promise<TaskControlReport> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = await this.tasks.get(taskId);
      const state = await this.tasks.getState(taskId);
      assertSynchronized(task, state);
      if (state.status === "cancelled") {
        return { task, state, nextCommand: `cxo task resume ${taskId}`, idempotent: true };
      }
      if (state.status === "completed" || state.status === "failed") {
        throw new OrchestratorError(`Task ${taskId} cannot be cancelled from ${state.status}`, {
          code: "TASK_STATE",
        });
      }
      try {
        return await this.transition(task, state, "cancelled", "Cancellation requested by user", {
          nextCommand: `cxo task resume ${taskId}`,
        });
      } catch (error) {
        if (!isConcurrentUpdate(error) || attempt === 2) throw error;
      }
    }
    throw new OrchestratorError(`Unable to persist cancellation for ${taskId}`, {
      code: "TASK_STATE",
      resumable: true,
    });
  }

  async resume(taskId: string): Promise<TaskControlReport> {
    const initialState = await this.tasks.getState(taskId);
    if (
      (initialState.status === "blocked" || initialState.status === "cancelled") &&
      (initialState.resumableFrom === "normalizing" || initialState.resumableFrom === "created")
    ) {
      if (this.normalizationResumer === undefined) {
        throw new OrchestratorError("Normalization resume service is unavailable", {
          code: "TASK_STATE",
          resumable: true,
        });
      }
      const result = await this.normalizationResumer.resumeNormalization(taskId);
      const state = await this.tasks.getState(taskId);
      return {
        task: result.task,
        state,
        nextCommand: `cxo task diagnose ${taskId}`,
        idempotent: false,
      };
    }
    const operationLock = await this.operationLocks.acquire(`task-operation:${taskId}`);
    try {
      return await this.resumeLocked(taskId);
    } finally {
      await operationLock.release();
    }
  }

  private async resumeLocked(taskId: string): Promise<TaskControlReport> {
    const task = await this.tasks.get(taskId);
    const state = await this.tasks.getState(taskId);
    assertSynchronized(task, state);
    if (state.status !== "blocked" && state.status !== "cancelled") {
      throw new OrchestratorError(`Task ${taskId} cannot resume from ${state.status}`, {
        code: "TASK_STATE",
      });
    }
    const origin = state.resumableFrom;
    if (origin === undefined) {
      throw new OrchestratorError(`Task ${taskId} has no safe resume boundary`, {
        code: "TASK_STATE",
      });
    }
    await this.reconcileInterruptedExecutions(task, state.status);
    await this.usage?.releaseAllReservations(task.projectId, task.id);
    const target = resumeTarget(origin);
    const nextCommand = await this.assertResumeIntegrity(task, target);
    return this.transition(task, state, target, `User resumed task from ${origin}`, {
      nextCommand,
    });
  }

  private async assertResumeIntegrity(task: Task, target: TaskStatus): Promise<string> {
    if (target === "ready-for-diagnosis") return `cxo task diagnose ${task.id}`;
    const project = await this.projects.inspect(task.projectId);
    const diagnosis = await this.diagnoses.read(project.id, task.id);
    const primaryHead = await this.git.resolveCommit(project.gitRoot, "HEAD");
    if (
      task.baseCommit === undefined ||
      diagnosis.sourceCommit !== task.baseCommit ||
      primaryHead !== diagnosis.sourceCommit
    ) {
      throw new OrchestratorError("Task source changed; refresh and rediagnose before resuming", {
        code: "CONTEXT_INTEGRITY",
        resumable: true,
      });
    }
    if (task.worktree !== undefined) {
      const manager = new WorktreeManager(this.paths, this.git);
      const inspected = await manager.inspect(project.gitRoot, task.worktree.path);
      if (inspected.branch !== task.worktree.branch) {
        throw new OrchestratorError("Persisted worktree branch changed", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      if (!(await this.git.isAncestor(project.gitRoot, task.baseCommit, task.worktree.branch))) {
        throw new OrchestratorError("Task base is not an ancestor of its worktree branch", {
          code: "CONTEXT_INTEGRITY",
        });
      }
    }
    if (target === "reviewing") {
      if (task.worktree === undefined) {
        throw new OrchestratorError("Review resume requires the task worktree", {
          code: "TASK_STATE",
        });
      }
      const diff = await new DiffService(this.paths).read(project.id, task.id);
      await new DiffService(this.paths).assertCurrent(diff, task.worktree.path);
      const verification = await this.verification.read(project.id, task.id);
      if (
        verification.overallStatus !== "passed" ||
        verification.diffHash !== diff.diffHash ||
        verification.sourceCommit !== diagnosis.sourceCommit
      ) {
        throw new OrchestratorError("Review resume requires current passing verification", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      return `cxo task review ${task.id}`;
    }
    return `cxo task run ${task.id}`;
  }

  private async transition(
    task: Task,
    state: TaskStateDocument,
    nextState: TaskStatus,
    reason: string,
    report: { nextCommand?: string },
  ): Promise<TaskControlReport> {
    const timestamp = isoNow(this.clock);
    const next = this.stateMachine.transition(state, {
      nextState,
      timestamp,
      reason,
      actor: "user",
    });
    const updated = {
      ...task,
      status: nextState,
      revision: task.revision + 1,
      updatedAt: timestamp,
    };
    await this.tasks.update(updated, next);
    return { task: updated, state: next, ...report, idempotent: false };
  }

  private async reconcileInterruptedExecutions(
    task: Task,
    status: "blocked" | "cancelled",
  ): Promise<void> {
    if (this.executions === undefined) return;
    const timestamp = isoNow(this.clock);
    for (const attempt of (await this.executions.list(task.projectId, task.id)).filter(
      (candidate) => candidate.status === "running",
    )) {
      await this.executions.save(task.projectId, {
        ...attempt,
        completedAt: timestamp,
        status,
        error: {
          name: "OrchestratorError",
          message: "Interrupted execution reconciled at the safe resume boundary",
          code: status === "cancelled" ? "CANCELLED" : "TASK_STATE",
          resumable: true,
        },
      });
    }
  }
}

function isConcurrentUpdate(error: unknown): boolean {
  return (
    error instanceof OrchestratorError &&
    error.code === "TASK_STATE" &&
    error.message.startsWith("Concurrent task update detected")
  );
}

export function resumeTarget(origin: TaskStatus): TaskStatus {
  if (["ready-for-diagnosis", "diagnosing"].includes(origin)) {
    return "ready-for-diagnosis";
  }
  if (
    [
      "diagnosed",
      "worktree-preparing",
      "ready-for-implementation",
      "implementing",
      "verifying",
      "correcting",
    ].includes(origin)
  ) {
    return "ready-for-implementation";
  }
  if (origin === "reviewing") return "reviewing";
  throw new OrchestratorError(`No safe resume boundary exists for ${origin}`, {
    code: "TASK_STATE",
  });
}

function assertSynchronized(task: Task, state: TaskStateDocument): void {
  if (task.status !== state.status) {
    throw new OrchestratorError("Task and state documents disagree", {
      code: "CONTEXT_INTEGRITY",
    });
  }
}
