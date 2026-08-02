import type { Task } from "../../domain/task/task.js";
import { taskBranchName } from "../../infrastructure/git/branch-naming.js";
import { GitClient } from "../../infrastructure/git/git-client.js";
import { GitCommandLog } from "../../infrastructure/git/git-command-log.js";
import { RepositoryLock } from "../../infrastructure/git/repository-lock.js";
import type {
  CleanupWorktreeOptions,
  CleanupWorktreeReport,
  PreparedWorktree,
} from "../../infrastructure/git/worktree-manager.js";
import { WorktreeManager } from "../../infrastructure/git/worktree-manager.js";
import type { DiagnosisFileRepository } from "../../infrastructure/persistence/diagnosis-file-repository.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError, toOrchestratorError } from "../../shared/errors.js";
import { TaskStateMachine } from "../../orchestration/engine/state-machine.js";
import type { ProjectManager } from "../projects/project-service.js";

export type WorktreePreparationReport = {
  task: Task;
  worktree: PreparedWorktree;
};

export class TaskWorktreeService {
  private readonly stateMachine = new TaskStateMachine();
  private readonly repositoryLock: RepositoryLock;
  private readonly gitLog: GitCommandLog;

  constructor(
    private readonly paths: StatePaths,
    private readonly tasks: TaskFileRepository,
    private readonly projects: ProjectManager,
    private readonly diagnoses: DiagnosisFileRepository,
    private readonly clock: Clock = systemClock,
  ) {
    this.repositoryLock = new RepositoryLock(paths);
    this.gitLog = new GitCommandLog(paths);
  }

  async prepare(taskId: string): Promise<WorktreePreparationReport> {
    const initialTask = await this.tasks.get(taskId);
    const lock = await this.repositoryLock.acquireWriter(initialTask.projectId);
    let task = initialTask;
    let state = await this.tasks.getState(taskId);
    try {
      if (state.status === "ready-for-implementation" && task.worktree !== undefined) {
        const project = await this.projects.inspect(task.projectId);
        const git = this.scopedGit(task);
        const manager = new WorktreeManager(this.paths, git);
        const inspected = await manager.inspect(project.gitRoot, task.worktree.path);
        if (
          inspected.branch !== task.worktree.branch ||
          inspected.head !== task.worktree.baseCommit ||
          (await git.statusPorcelain(inspected.path)) !== ""
        ) {
          throw new OrchestratorError("Persisted task worktree failed its integrity check", {
            code: "CONTEXT_INTEGRITY",
            resumable: true,
          });
        }
        return {
          task,
          worktree: {
            path: inspected.path,
            branch: task.worktree.branch,
            baseCommit: task.worktree.baseCommit,
            headCommit: inspected.head,
            reused: true,
          },
        };
      }
      if (state.status !== "diagnosed" && state.status !== "ready-for-implementation") {
        throw new OrchestratorError(
          `Task ${taskId} cannot prepare a worktree from state ${state.status}`,
          { code: "TASK_STATE", nextCommand: `cxo task status ${taskId}` },
        );
      }

      const startedAt = isoNow(this.clock);
      if (state.status === "diagnosed" || state.status === "ready-for-implementation") {
        state = this.stateMachine.transition(state, {
          nextState: "worktree-preparing",
          timestamp: startedAt,
          reason: "Preparing isolated implementation worktree",
          actor: "system",
        });
        task = {
          ...task,
          status: "worktree-preparing",
          revision: task.revision + 1,
          updatedAt: startedAt,
        };
        await this.tasks.update(task, state);
      }

      const project = await this.projects.inspect(task.projectId);
      const diagnosis = await this.diagnoses.read(task.projectId, task.id);
      if (
        task.baseCommit === undefined ||
        diagnosis.sourceCommit !== task.baseCommit ||
        diagnosis.taskId !== task.id
      ) {
        throw new OrchestratorError("Diagnosis and task base commit are incompatible", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const git = this.scopedGit(task);
      const resolvedBase = await git.resolveCommit(project.gitRoot, task.baseCommit);
      const primaryHead = await git.resolveCommit(project.gitRoot, "HEAD");
      const primaryStatus = await git.statusPorcelain(project.gitRoot);
      const manager = new WorktreeManager(this.paths, git);
      const worktree = await manager.prepare({
        projectId: project.id,
        taskId: task.id,
        repositoryRoot: project.gitRoot,
        baseCommit: resolvedBase,
        branch: taskBranchName(task.id, task.title),
      });
      if (
        (await git.resolveCommit(project.gitRoot, "HEAD")) !== primaryHead ||
        (await git.statusPorcelain(project.gitRoot)) !== primaryStatus
      ) {
        throw new OrchestratorError("Primary checkout changed while preparing a worktree", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const completedAt = isoNow(this.clock);
      state = this.stateMachine.transition(state, {
        nextState: "ready-for-implementation",
        timestamp: completedAt,
        reason: `Isolated worktree ready at ${worktree.path}`,
        actor: "system",
      });
      task = {
        ...task,
        status: "ready-for-implementation",
        worktree: {
          path: worktree.path,
          branch: worktree.branch,
          baseCommit: worktree.baseCommit,
          createdAt: completedAt,
        },
        revision: task.revision + 1,
        updatedAt: completedAt,
      };
      await this.tasks.update(task, state);
      return { task, worktree };
    } catch (error) {
      const normalized = toOrchestratorError(error);
      const persistedState = await this.tasks.getState(taskId);
      if (persistedState.status === "cancelled") {
        throw new OrchestratorError("Task worktree preparation was cancelled", {
          code: "CANCELLED",
          resumable: true,
          cause: error,
        });
      }
      if (state.status === "worktree-preparing") {
        const blockedAt = isoNow(this.clock);
        state = this.stateMachine.transition(state, {
          nextState: "blocked",
          timestamp: blockedAt,
          reason: normalized.message,
          actor: "system",
        });
        task = {
          ...task,
          status: "blocked",
          revision: task.revision + 1,
          updatedAt: blockedAt,
        };
        await this.tasks.update(task, state);
      }
      throw normalized;
    } finally {
      await lock.release();
    }
  }

  async cleanup(
    taskId: string,
    options: CleanupWorktreeOptions = {},
  ): Promise<CleanupWorktreeReport> {
    let task = await this.tasks.get(taskId);
    if (task.worktree === undefined) {
      throw new OrchestratorError(`Task ${taskId} has no worktree to clean up`, {
        code: "TASK_STATE",
      });
    }
    const lock = await this.repositoryLock.acquireWriter(task.projectId);
    try {
      const project = await this.projects.inspect(task.projectId);
      const git = this.scopedGit(task);
      const manager = new WorktreeManager(this.paths, git);
      const primaryHead = await git.resolveCommit(project.gitRoot, "HEAD");
      const primaryStatus = await git.statusPorcelain(project.gitRoot);
      const report = await manager.cleanup(project.gitRoot, task.worktree, options);
      if (
        (await git.resolveCommit(project.gitRoot, "HEAD")) !== primaryHead ||
        (await git.statusPorcelain(project.gitRoot)) !== primaryStatus
      ) {
        throw new OrchestratorError("Primary checkout changed during task cleanup", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const { worktree: removedWorktree, ...withoutWorktree } = task;
      void removedWorktree;
      task = {
        ...withoutWorktree,
        revision: task.revision + 1,
        updatedAt: isoNow(this.clock),
      };
      await this.tasks.update(task);
      return report;
    } finally {
      await lock.release();
    }
  }

  private scopedGit(task: Task): GitClient {
    return new GitClient({
      observer: async (record) => this.gitLog.append(task.projectId, task.id, record),
    });
  }
}
