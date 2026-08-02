import { access, constants, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import type { ExecutionProfile } from "../configuration/config-schema.js";
import type { ProjectManager } from "../projects/project-service.js";
import {
  taskDraftSchema,
  taskSchema,
  type Task,
  type TaskDraft,
  type TaskDraftBase,
  type TaskStatus,
} from "../../domain/task/task.js";
import type { TaskStateDocument } from "../../domain/task/task-state.js";
import { OrchestratorError, toOrchestratorError } from "../../shared/errors.js";
import { AtomicJsonStore } from "../../infrastructure/persistence/atomic-json-store.js";
import { FileLockManager } from "../../infrastructure/persistence/file-lock.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import type { UsageFileRepository } from "../../infrastructure/persistence/usage-file-repository.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";
import { TaskStateMachine } from "../../orchestration/engine/state-machine.js";
import { classifyTaskType, DeterministicTaskNormalizer } from "./deterministic-task-normalizer.js";
import { PersistedTaskCancellation } from "./persisted-task-cancellation.js";
import { enrichRisk } from "./risk-enricher.js";
import { taskFailureStatus } from "./task-failure-policy.js";
import type { TaskNormalizer } from "./task-normalizer.js";

const normalizationPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    draft: taskDraftSchema,
    childTaskIds: z.array(z.string().min(1)),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.draft.childTasks.length !== value.childTaskIds.length) {
      context.addIssue({
        code: "custom",
        message: "Normalization child task IDs do not match the validated draft",
      });
    }
  });

type NormalizationPlan = z.infer<typeof normalizationPlanSchema>;

export type TaskCreateResult = { task: Task; childTasks: Task[] };

export interface TaskManager {
  create(input: {
    project: string;
    feedback: string;
    profile: ExecutionProfile;
  }): Promise<TaskCreateResult>;
  resumeNormalization?(taskId: string): Promise<TaskCreateResult>;
  list(filter?: { project?: string; status?: TaskStatus }): Promise<Task[]>;
  inspect(taskId: string): Promise<Task>;
  status(taskId: string): Promise<{ task: Task; state: TaskStateDocument }>;
}

export class TaskService implements TaskManager {
  private readonly stateMachine = new TaskStateMachine();
  private readonly locks: FileLockManager;
  private readonly store = new AtomicJsonStore();
  private readonly deterministicNormalizer = new DeterministicTaskNormalizer();

  constructor(
    private readonly paths: StatePaths,
    private readonly tasks: TaskFileRepository,
    private readonly projects: ProjectManager,
    private readonly normalizer: TaskNormalizer,
    private readonly usage?: UsageFileRepository,
    private readonly executions?: ExecutionFileRepository,
    private readonly clock: Clock = systemClock,
  ) {
    this.locks = new FileLockManager(paths.locksDirectory);
  }

  async create(input: {
    project: string;
    feedback: string;
    profile: ExecutionProfile;
  }): Promise<TaskCreateResult> {
    if (input.feedback.trim() === "") {
      throw new OrchestratorError("Task feedback must not be empty", { code: "CLI_INPUT" });
    }
    const inspectedProject = await this.projects.inspect(input.project);
    const projectLock = await this.locks.acquire(`project-operation:${inspectedProject.id}`);
    try {
      const project = await this.projects.inspect(inspectedProject.id);
      const preliminaryType = classifyTaskType(input.feedback);
      const parentId = await this.tasks.allocateId(preliminaryType);
      const operationLock = await this.locks.acquire(`task-operation:${parentId}`);
      try {
        const originalPath = await this.tasks.preserveOriginalFeedback(
          project.id,
          parentId,
          input.feedback,
        );
        const timestamp = isoNow(this.clock);
        const provisionalDraft = taskDraftSchema.parse(
          await this.deterministicNormalizer.normalize({
            taskId: parentId,
            projectId: project.id,
            profile: input.profile,
            originalFeedback: input.feedback,
            workingDirectory: project.gitRoot,
          }),
        );
        const task = this.buildTask({
          id: parentId,
          projectId: project.id,
          profile: input.profile,
          originalPath,
          draft: provisionalDraft,
          childTaskIds: [],
          timestamp,
          baseRef: project.baseRef,
          status: "normalizing",
        });
        await this.tasks.create(task, this.initialNormalizingState(parentId, timestamp));
        return await this.normalizePersistedTask(task, project.gitRoot, input.feedback);
      } finally {
        await operationLock.release();
      }
    } finally {
      await projectLock.release();
    }
  }

  async resumeNormalization(taskId: string): Promise<TaskCreateResult> {
    const initial = await this.tasks.get(taskId);
    const projectLock = await this.locks.acquire(`project-operation:${initial.projectId}`);
    try {
      const operationLock = await this.locks.acquire(`task-operation:${taskId}`);
      try {
        let task = await this.tasks.get(taskId);
        let state = await this.tasks.getState(taskId);
        if (
          (state.status !== "blocked" && state.status !== "cancelled") ||
          (state.resumableFrom !== "normalizing" && state.resumableFrom !== "created")
        ) {
          throw new OrchestratorError(
            `Task ${taskId} does not have an interrupted normalization to resume`,
            { code: "TASK_STATE" },
          );
        }
        await this.reconcileInterruptedExecutions(task, state.status);
        await this.usage?.releaseAllReservations(task.projectId, task.id);
        const timestamp = isoNow(this.clock);
        state = this.stateMachine.transition(state, {
          nextState: "normalizing",
          timestamp,
          reason: "User resumed structured normalization",
          actor: "user",
        });
        task = {
          ...task,
          status: "normalizing",
          revision: task.revision + 1,
          updatedAt: timestamp,
        };
        await this.tasks.update(task, state);
        const project = await this.projects.inspect(task.projectId);
        const expectedFeedbackPath = this.tasks.originalFeedbackPath(task.projectId, task.id);
        if (task.originalFeedbackPath !== expectedFeedbackPath) {
          throw new OrchestratorError("Original feedback path is not bound to the task", {
            code: "CONTEXT_INTEGRITY",
          });
        }
        return await this.normalizePersistedTask(
          task,
          project.gitRoot,
          await readFile(expectedFeedbackPath, "utf8"),
        );
      } finally {
        await operationLock.release();
      }
    } finally {
      await projectLock.release();
    }
  }

  async list(filter: { project?: string; status?: TaskStatus } = {}): Promise<Task[]> {
    const projectId =
      filter.project === undefined ? undefined : (await this.projects.inspect(filter.project)).id;
    const tasks = await this.tasks.list(projectId);
    return tasks.filter((task) => filter.status === undefined || task.status === filter.status);
  }

  inspect(taskId: string): Promise<Task> {
    return this.tasks.get(taskId);
  }

  async status(taskId: string): Promise<{ task: Task; state: TaskStateDocument }> {
    return { task: await this.tasks.get(taskId), state: await this.tasks.getState(taskId) };
  }

  private async normalizePersistedTask(
    initialTask: Task,
    workingDirectory: string,
    originalFeedback: string,
  ): Promise<TaskCreateResult> {
    const cancellation = new PersistedTaskCancellation(this.tasks, initialTask.id);
    try {
      let plan = await this.readNormalizationPlan(initialTask.projectId, initialTask.id);
      if (plan === undefined) {
        const draft = taskDraftSchema.parse(
          await this.normalizer.normalize({
            taskId: initialTask.id,
            projectId: initialTask.projectId,
            profile: initialTask.profile,
            originalFeedback,
            workingDirectory,
            abortSignal: cancellation.signal,
          }),
        );
        this.throwIfCancelled(cancellation.signal, initialTask.id);
        plan = normalizationPlanSchema.parse({
          schemaVersion: 1,
          taskId: initialTask.id,
          draft,
          childTaskIds: await Promise.all(
            draft.childTasks.map(async (child) => this.tasks.allocateId(child.type)),
          ),
          createdAt: isoNow(this.clock),
        });
        await this.store.write(
          this.normalizationPlanPath(initialTask.projectId, initialTask.id),
          plan,
        );
      }
      return await this.finalizeNormalization(initialTask.id, plan, cancellation.signal);
    } catch (error) {
      let normalized = toOrchestratorError(error);
      const task = await this.tasks.get(initialTask.id);
      const state = await this.tasks.getState(initialTask.id);
      if (state.status === "cancelled") {
        normalized = new OrchestratorError(`Task ${initialTask.id} normalization was cancelled`, {
          code: "CANCELLED",
          resumable: true,
          nextCommand: `cxo task resume ${initialTask.id}`,
          cause: error,
        });
      } else if (state.status === "normalizing") {
        const timestamp = isoNow(this.clock);
        const nextStatus = taskFailureStatus(normalized);
        const nextState = this.stateMachine.transition(state, {
          nextState: nextStatus,
          timestamp,
          reason: normalized.message,
          actor: "system",
        });
        await this.tasks.update(
          {
            ...task,
            status: nextStatus,
            revision: task.revision + 1,
            updatedAt: timestamp,
          },
          nextState,
        );
      }
      throw new OrchestratorError(`${normalized.message} (durable task: ${initialTask.id})`, {
        code: normalized.code,
        resumable: normalized.resumable,
        ...(normalized.resumable ? { nextCommand: `cxo task resume ${initialTask.id}` } : {}),
        cause: normalized,
      });
    } finally {
      cancellation.dispose();
    }
  }

  private async finalizeNormalization(
    taskId: string,
    plan: NormalizationPlan,
    abortSignal: AbortSignal,
  ): Promise<TaskCreateResult> {
    if (plan.taskId !== taskId) {
      throw new OrchestratorError("Normalization plan identity mismatch", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    let parent = await this.tasks.get(taskId);
    let parentState = await this.tasks.getState(taskId);
    if (parentState.status !== "normalizing") {
      throw new OrchestratorError(`Task ${taskId} left normalization before finalization`, {
        code: "TASK_STATE",
        resumable: parentState.status === "cancelled",
      });
    }
    const childTasks: Task[] = [];
    const existingTasks = await this.tasks.list(parent.projectId);
    for (const [index, childDraft] of plan.draft.childTasks.entries()) {
      this.throwIfCancelled(abortSignal, taskId);
      const childId = plan.childTaskIds[index];
      if (childId === undefined) {
        throw new OrchestratorError("Normalization plan is missing a child task ID", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const existing = existingTasks.find((candidate) => candidate.id === childId);
      if (existing !== undefined) {
        if (existing.parentTaskId !== taskId || existing.projectId !== parent.projectId) {
          throw new OrchestratorError("Normalization child task identity mismatch", {
            code: "CONTEXT_INTEGRITY",
          });
        }
        childTasks.push(existing);
        continue;
      }
      const timestamp = isoNow(this.clock);
      const child = this.buildTask({
        id: childId,
        projectId: parent.projectId,
        profile: parent.profile,
        originalPath: parent.originalFeedbackPath,
        draft: childDraft,
        childTaskIds: [],
        parentTaskId: taskId,
        timestamp,
        ...(parent.baseRef === undefined ? {} : { baseRef: parent.baseRef }),
        status: "ready-for-diagnosis",
      });
      await this.tasks.create(child, this.initialReadyState(childId, timestamp));
      childTasks.push(child);
    }

    this.throwIfCancelled(abortSignal, taskId);
    parent = await this.tasks.get(taskId);
    parentState = await this.tasks.getState(taskId);
    if (parentState.status !== "normalizing") {
      throw new OrchestratorError(`Task ${taskId} was interrupted during normalization`, {
        code: parentState.status === "cancelled" ? "CANCELLED" : "TASK_STATE",
        resumable: parentState.status === "cancelled",
      });
    }
    const timestamp = isoNow(this.clock);
    const finalized = this.buildTask({
      id: parent.id,
      projectId: parent.projectId,
      profile: parent.profile,
      originalPath: parent.originalFeedbackPath,
      draft: plan.draft,
      childTaskIds: plan.childTaskIds,
      timestamp,
      ...(parent.baseRef === undefined ? {} : { baseRef: parent.baseRef }),
      status: "ready-for-diagnosis",
    });
    const readyState = this.stateMachine.transition(parentState, {
      nextState: "ready-for-diagnosis",
      timestamp,
      reason: "Structured task validated and persisted",
      actor: "system",
    });
    const updated = taskSchema.parse({
      ...finalized,
      revision: parent.revision + 1,
      createdAt: parent.createdAt,
    });
    await this.tasks.update(updated, readyState);
    return { task: updated, childTasks };
  }

  private buildTask(input: {
    id: string;
    projectId: string;
    profile: ExecutionProfile;
    originalPath: string;
    draft: TaskDraftBase | TaskDraft;
    childTaskIds: string[];
    parentTaskId?: string;
    timestamp: string;
    baseRef?: string;
    status: TaskStatus;
  }): Task {
    return taskSchema.parse({
      schemaVersion: 1,
      revision: 1,
      id: input.id,
      projectId: input.projectId,
      ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
      childTaskIds: input.childTaskIds,
      type: input.draft.type,
      title: input.draft.title,
      summary: input.draft.summary,
      originalFeedbackPath: input.originalPath,
      profile: input.profile,
      risk: enrichRisk(input.draft.riskSignals),
      riskSignals: input.draft.riskSignals,
      status: input.status,
      reports: input.draft.reports,
      constraints: input.draft.constraints,
      acceptanceCriteria: input.draft.acceptanceCriteria,
      protectedContracts: input.draft.protectedContracts,
      assumptions: input.draft.assumptions,
      unknowns: input.draft.unknowns,
      requestedScope: input.draft.suggestedScope,
      ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    });
  }

  private initialNormalizingState(taskId: string, timestamp: string): TaskStateDocument {
    const created: TaskStateDocument = {
      schemaVersion: 1,
      taskId,
      status: "created",
      transitions: [],
      updatedAt: timestamp,
    };
    return this.stateMachine.transition(created, {
      nextState: "normalizing",
      timestamp,
      reason: "Original feedback preserved; structured normalization started",
      actor: "system",
    });
  }

  private initialReadyState(taskId: string, timestamp: string): TaskStateDocument {
    return this.stateMachine.transition(this.initialNormalizingState(taskId, timestamp), {
      nextState: "ready-for-diagnosis",
      timestamp,
      reason: "Structured child task validated and persisted",
      actor: "system",
    });
  }

  private normalizationPlanPath(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "normalization-plan.json");
  }

  private async readNormalizationPlan(
    projectId: string,
    taskId: string,
  ): Promise<NormalizationPlan | undefined> {
    const path = this.normalizationPlanPath(projectId, taskId);
    try {
      await access(path, constants.F_OK);
    } catch {
      return undefined;
    }
    return this.store.read(path, normalizationPlanSchema);
  }

  private throwIfCancelled(signal: AbortSignal, taskId: string): void {
    if (!signal.aborted) return;
    throw new OrchestratorError(`Task ${taskId} normalization was cancelled`, {
      code: "CANCELLED",
      resumable: true,
    });
  }

  private async reconcileInterruptedExecutions(
    task: Task,
    state: "blocked" | "cancelled",
  ): Promise<void> {
    if (this.executions === undefined) return;
    const timestamp = isoNow(this.clock);
    for (const attempt of (await this.executions.list(task.projectId, task.id)).filter(
      (candidate) => candidate.status === "running",
    )) {
      await this.executions.save(task.projectId, {
        ...attempt,
        completedAt: timestamp,
        status: state,
        error: {
          name: "OrchestratorError",
          message: "Interrupted execution reconciled at the safe normalization resume boundary",
          code: state === "cancelled" ? "CANCELLED" : "TASK_STATE",
          resumable: true,
        },
      });
    }
  }
}
