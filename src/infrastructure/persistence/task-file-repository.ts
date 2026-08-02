import { access, constants, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { formatTaskId, taskCounterKey } from "../../shared/ids.js";
import { OrchestratorError } from "../../shared/errors.js";
import { taskSchema, type Task, type TaskType } from "../../domain/task/task.js";
import { taskStateDocumentSchema, type TaskStateDocument } from "../../domain/task/task-state.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { FileLockManager } from "./file-lock.js";
import type { StatePaths } from "./state-paths.js";

const taskIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(
      z.object({ taskId: z.string().min(1), projectId: z.string().min(1) }).strict(),
    ),
    updatedAt: z.string().datetime(),
  })
  .strict();

const taskCounterSchema = z
  .object({
    schemaVersion: z.literal(1),
    counters: z.record(z.string(), z.number().int().nonnegative()),
    updatedAt: z.string().datetime(),
  })
  .strict();

type TaskIndex = z.infer<typeof taskIndexSchema>;

export class TaskFileRepository {
  private readonly locks: FileLockManager;

  constructor(
    private readonly paths: StatePaths,
    private readonly store = new AtomicJsonStore(),
    private readonly clock: Clock = systemClock,
  ) {
    this.locks = new FileLockManager(paths.locksDirectory);
  }

  async allocateId(type: TaskType): Promise<string> {
    const lock = await this.locks.acquire("tasks:counters");
    try {
      const counters = await this.readCounters();
      const year = this.clock.now().getUTCFullYear();
      const key = taskCounterKey(type, year);
      const next = (counters.counters[key] ?? 0) + 1;
      counters.counters[key] = next;
      counters.updatedAt = isoNow(this.clock);
      await this.store.write(this.paths.taskCountersFile, counters);
      return formatTaskId(type, year, next);
    } finally {
      await lock.release();
    }
  }

  originalFeedbackPath(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "original-feedback.md");
  }

  async preserveOriginalFeedback(
    projectId: string,
    taskId: string,
    feedback: string,
  ): Promise<string> {
    const path = this.originalFeedbackPath(projectId, taskId);
    await mkdir(this.paths.taskDirectory(projectId, taskId), { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(feedback, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      return path;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw new OrchestratorError(
        `Original feedback is immutable and already exists for ${taskId}`,
        {
          code: "TASK_STATE",
          cause: error,
        },
      );
    }
  }

  async create(task: Task, state: TaskStateDocument): Promise<void> {
    const lock = await this.locks.acquire("tasks:index");
    try {
      const index = await this.readIndex();
      if (index.entries.some((entry) => entry.taskId === task.id)) {
        throw new OrchestratorError(`Task already exists: ${task.id}`, { code: "TASK_STATE" });
      }
      await this.store.write(this.taskFile(task.projectId, task.id), taskSchema.parse(task));
      await this.store.write(
        this.stateFile(task.projectId, task.id),
        taskStateDocumentSchema.parse(state),
      );
      index.entries.push({ taskId: task.id, projectId: task.projectId });
      index.entries.sort((left, right) => left.taskId.localeCompare(right.taskId));
      index.updatedAt = isoNow(this.clock);
      await this.store.write(this.paths.tasksIndexFile, index);
    } finally {
      await lock.release();
    }
  }

  async update(task: Task, state?: TaskStateDocument): Promise<void> {
    const lock = await this.locks.acquire(`task:${task.id}`);
    try {
      const existing = await this.get(task.id);
      if (existing.projectId !== task.projectId) {
        throw new OrchestratorError("Task project identity cannot change", { code: "TASK_STATE" });
      }
      await this.store.write(this.taskFile(task.projectId, task.id), taskSchema.parse(task));
      if (state !== undefined) {
        await this.store.write(
          this.stateFile(task.projectId, task.id),
          taskStateDocumentSchema.parse(state),
        );
      }
    } finally {
      await lock.release();
    }
  }

  async get(taskId: string): Promise<Task> {
    const entry = (await this.readIndex()).entries.find((item) => item.taskId === taskId);
    if (entry === undefined) {
      throw new OrchestratorError(`Task not found: ${taskId}`, {
        code: "TASK_STATE",
        nextCommand: "cxo task list",
      });
    }
    return this.store.read(this.taskFile(entry.projectId, taskId), taskSchema);
  }

  async getState(taskId: string): Promise<TaskStateDocument> {
    const task = await this.get(taskId);
    return this.store.read(this.stateFile(task.projectId, taskId), taskStateDocumentSchema);
  }

  async list(projectId?: string): Promise<Task[]> {
    const entries = (await this.readIndex()).entries.filter(
      (entry) => projectId === undefined || entry.projectId === projectId,
    );
    return Promise.all(
      entries.map(async (entry) =>
        this.store.read(this.taskFile(entry.projectId, entry.taskId), taskSchema),
      ),
    );
  }

  private taskFile(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "task.json");
  }

  private stateFile(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "state.json");
  }

  private async readIndex(): Promise<TaskIndex> {
    if (!(await exists(this.paths.tasksIndexFile))) {
      return { schemaVersion: 1, entries: [], updatedAt: isoNow(this.clock) };
    }
    return this.store.read(this.paths.tasksIndexFile, taskIndexSchema);
  }

  private async readCounters(): Promise<z.infer<typeof taskCounterSchema>> {
    if (!(await exists(this.paths.taskCountersFile))) {
      return { schemaVersion: 1, counters: {}, updatedAt: isoNow(this.clock) };
    }
    return this.store.read(this.paths.taskCountersFile, taskCounterSchema);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
