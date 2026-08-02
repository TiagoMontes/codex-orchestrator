import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import type { ExecutionProfile } from "../configuration/config-schema.js";
import type { ProjectManager } from "../projects/project-service.js";
import {
  taskDraftSchema,
  taskSchema,
  type Task,
  type TaskDraftBase,
  type TaskStatus,
} from "../../domain/task/task.js";
import type { TaskStateDocument } from "../../domain/task/task-state.js";
import { OrchestratorError } from "../../shared/errors.js";
import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import { TaskStateMachine } from "../../orchestration/engine/state-machine.js";
import { classifyTaskType } from "./deterministic-task-normalizer.js";
import { enrichRisk } from "./risk-enricher.js";
import type { TaskNormalizer } from "./task-normalizer.js";

export type TaskCreateResult = { task: Task; childTasks: Task[] };

export interface TaskManager {
  create(input: {
    project: string;
    feedback: string;
    profile: ExecutionProfile;
  }): Promise<TaskCreateResult>;
  list(filter?: { project?: string; status?: TaskStatus }): Promise<Task[]>;
  inspect(taskId: string): Promise<Task>;
  status(taskId: string): Promise<{ task: Task; state: TaskStateDocument }>;
}

export class TaskService implements TaskManager {
  private readonly stateMachine = new TaskStateMachine();

  constructor(
    private readonly tasks: TaskFileRepository,
    private readonly projects: ProjectManager,
    private readonly normalizer: TaskNormalizer,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: {
    project: string;
    feedback: string;
    profile: ExecutionProfile;
  }): Promise<TaskCreateResult> {
    if (input.feedback.trim() === "") {
      throw new OrchestratorError("Task feedback must not be empty", { code: "CLI_INPUT" });
    }
    const project = await this.projects.inspect(input.project);
    const preliminaryType = classifyTaskType(input.feedback);
    const parentId = await this.tasks.allocateId(preliminaryType);
    const originalPath = await this.tasks.preserveOriginalFeedback(
      project.id,
      parentId,
      input.feedback,
    );
    const draft = taskDraftSchema.parse(
      await this.normalizer.normalize({
        taskId: parentId,
        projectId: project.id,
        profile: input.profile,
        originalFeedback: input.feedback,
      }),
    );
    const timestamp = isoNow(this.clock);

    const childIds = await Promise.all(
      draft.childTasks.map(async (child) => this.tasks.allocateId(child.type)),
    );
    const task = this.buildTask({
      id: parentId,
      projectId: project.id,
      profile: input.profile,
      originalPath,
      draft,
      childTaskIds: childIds,
      timestamp,
      baseRef: project.baseRef,
    });
    await this.tasks.create(task, this.initialReadyState(parentId, timestamp));

    const childTasks: Task[] = [];
    for (const [index, childDraft] of draft.childTasks.entries()) {
      const childId = childIds[index];
      if (childId === undefined) continue;
      const childOriginal = await this.tasks.preserveOriginalFeedback(
        project.id,
        childId,
        input.feedback,
      );
      const child = this.buildTask({
        id: childId,
        projectId: project.id,
        profile: input.profile,
        originalPath: childOriginal,
        draft: childDraft,
        childTaskIds: [],
        parentTaskId: parentId,
        timestamp,
        baseRef: project.baseRef,
      });
      await this.tasks.create(child, this.initialReadyState(childId, timestamp));
      childTasks.push(child);
    }

    return { task, childTasks };
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

  private buildTask(input: {
    id: string;
    projectId: string;
    profile: ExecutionProfile;
    originalPath: string;
    draft: TaskDraftBase;
    childTaskIds: string[];
    parentTaskId?: string;
    timestamp: string;
    baseRef: string;
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
      status: "ready-for-diagnosis",
      reports: input.draft.reports,
      constraints: input.draft.constraints,
      acceptanceCriteria: input.draft.acceptanceCriteria,
      protectedContracts: input.draft.protectedContracts,
      assumptions: input.draft.assumptions,
      unknowns: input.draft.unknowns,
      requestedScope: input.draft.suggestedScope,
      baseRef: input.baseRef,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    });
  }

  private initialReadyState(taskId: string, timestamp: string): TaskStateDocument {
    const created: TaskStateDocument = {
      schemaVersion: 1,
      taskId,
      status: "created",
      transitions: [],
      updatedAt: timestamp,
    };
    const normalizing = this.stateMachine.transition(created, {
      nextState: "normalizing",
      timestamp,
      reason: "Original feedback preserved; structured normalization started",
      actor: "system",
    });
    return this.stateMachine.transition(normalizing, {
      nextState: "ready-for-diagnosis",
      timestamp,
      reason: "Structured task validated and persisted",
      actor: "system",
    });
  }
}
