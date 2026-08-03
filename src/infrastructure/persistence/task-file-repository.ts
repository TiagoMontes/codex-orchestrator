import { access, constants, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { formatTaskId, taskCounterKey } from "../../shared/ids.js";
import { OrchestratorError } from "../../shared/errors.js";
import { sha256, stableJson } from "../../shared/hashing.js";
import { taskSchema, type Task, type TaskType } from "../../domain/task/task.js";
import {
  canTransitionTask,
  taskStateDocumentSchema,
  type TaskStateDocument,
} from "../../domain/task/task-state.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { FileLockManager, type AcquiredLock } from "./file-lock.js";
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

const taskTransitionJournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    task: taskSchema,
    state: taskStateDocumentSchema,
  })
  .strict();

const legacyTaskSchema = taskSchema.omit({ originalFeedbackSha256: true });
const persistedTaskSchema = z.union([taskSchema, legacyTaskSchema]);

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
      assertCompleteStateHistory(state, task, true);
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
    const lock = await this.acquireTaskLock(task.id);
    try {
      await this.recoverTransitionUnlocked(task.projectId, task.id);
      const existing = await this.readTask(task.projectId, task.id);
      if (existing.projectId !== task.projectId) {
        throw new OrchestratorError("Task project identity cannot change", { code: "TASK_STATE" });
      }
      if (task.revision !== existing.revision + 1) {
        throw new OrchestratorError(
          `Concurrent task update detected for ${task.id}: expected revision ${existing.revision + 1}, received ${task.revision}`,
          { code: "TASK_STATE", resumable: true },
        );
      }
      const existingState = await this.store.read(
        this.stateFile(task.projectId, task.id),
        taskStateDocumentSchema,
      );
      assertCompleteStateHistory(existingState, existing, false);
      if (existing.id !== existingState.taskId || existing.status !== existingState.status) {
        throw new OrchestratorError("Persisted task and state are not synchronized", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      if (task.id !== existing.id || task.createdAt !== existing.createdAt) {
        throw new OrchestratorError("Task immutable identity fields cannot change", {
          code: "TASK_STATE",
        });
      }
      if (state === undefined && task.status !== existing.status) {
        throw new OrchestratorError("Task status changes require an atomic state transition", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      if (state !== undefined) {
        if (state.taskId !== task.id || state.status !== task.status) {
          throw new OrchestratorError("Task transition journal identities disagree", {
            code: "CONTEXT_INTEGRITY",
          });
        }
        assertStateUpdate(existingState, state, task);
        await this.store.write(this.transitionJournalFile(task.projectId, task.id), {
          schemaVersion: 1,
          task: taskSchema.parse(task),
          state: taskStateDocumentSchema.parse(state),
        });
      }
      await this.store.write(this.taskFile(task.projectId, task.id), taskSchema.parse(task));
      if (state !== undefined) {
        await this.store.write(
          this.stateFile(task.projectId, task.id),
          taskStateDocumentSchema.parse(state),
        );
        await rm(this.transitionJournalFile(task.projectId, task.id), { force: true });
      }
    } finally {
      await lock.release();
    }
  }

  async get(taskId: string): Promise<Task> {
    return (await this.getSnapshot(taskId)).task;
  }

  async getState(taskId: string): Promise<TaskStateDocument> {
    return (await this.getSnapshot(taskId)).state;
  }

  async getSnapshot(taskId: string): Promise<{ task: Task; state: TaskStateDocument }> {
    const entry = (await this.readIndex()).entries.find((item) => item.taskId === taskId);
    if (entry === undefined) {
      throw new OrchestratorError(`Task not found: ${taskId}`, {
        code: "TASK_STATE",
        nextCommand: "cxo task list",
      });
    }
    const lock = await this.acquireTaskLock(taskId);
    try {
      await this.recoverTransitionUnlocked(entry.projectId, taskId);
      const [task, state] = await Promise.all([
        this.readTask(entry.projectId, taskId),
        this.store.read(this.stateFile(entry.projectId, taskId), taskStateDocumentSchema),
      ]);
      if (task.id !== state.taskId || task.status !== state.status) {
        throw new OrchestratorError("Task and state snapshot identities disagree", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      assertCompleteStateHistory(state, task, false);
      return { task, state };
    } finally {
      await lock.release();
    }
  }

  async list(projectId?: string): Promise<Task[]> {
    const entries = (await this.readIndex()).entries.filter(
      (entry) => projectId === undefined || entry.projectId === projectId,
    );
    return Promise.all(entries.map(async (entry) => this.get(entry.taskId)));
  }

  async removeProjectEntries(projectId: string): Promise<number> {
    const lock = await this.locks.acquire("tasks:index");
    try {
      const index = await this.readIndex();
      const removed = index.entries.filter((entry) => entry.projectId === projectId).length;
      index.entries = index.entries.filter((entry) => entry.projectId !== projectId);
      index.updatedAt = isoNow(this.clock);
      await this.store.write(this.paths.tasksIndexFile, index);
      return removed;
    } finally {
      await lock.release();
    }
  }

  private taskFile(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "task.json");
  }

  private stateFile(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "state.json");
  }

  private transitionJournalFile(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "transition-journal.json");
  }

  private async recoverTransitionUnlocked(projectId: string, taskId: string): Promise<void> {
    const path = this.transitionJournalFile(projectId, taskId);
    if (!(await exists(path))) return;
    const journal = await this.store.read(path, taskTransitionJournalSchema);
    if (
      journal.task.id !== taskId ||
      journal.task.projectId !== projectId ||
      journal.state.taskId !== taskId ||
      journal.task.status !== journal.state.status
    ) {
      throw new OrchestratorError("Task transition journal identity mismatch", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const lastTransition = journal.state.transitions.at(-1);
    if (
      journal.state.updatedAt !== journal.task.updatedAt ||
      lastTransition === undefined ||
      lastTransition.nextState !== journal.task.status ||
      lastTransition.timestamp !== journal.task.updatedAt
    ) {
      throw new OrchestratorError("Task transition journal lineage mismatch", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const currentTask = await this.readTask(projectId, taskId);
    const currentState = await this.store.read(
      this.stateFile(projectId, taskId),
      taskStateDocumentSchema,
    );
    if (
      journal.task.id !== currentTask.id ||
      journal.task.projectId !== currentTask.projectId ||
      journal.task.createdAt !== currentTask.createdAt ||
      journal.task.originalFeedbackPath !== currentTask.originalFeedbackPath ||
      journal.task.originalFeedbackSha256 !== currentTask.originalFeedbackSha256
    ) {
      throw new OrchestratorError("Task transition journal changes immutable task identity", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    if (currentTask.revision === journal.task.revision) {
      if (stableJson(currentTask) !== stableJson(journal.task)) {
        throw new OrchestratorError("Task transition journal conflicts with current revision", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      if (stableJson(currentState) !== stableJson(journal.state)) {
        assertStateUpdate(currentState, journal.state, journal.task);
      }
    } else if (currentTask.revision === journal.task.revision - 1) {
      if (currentTask.status !== currentState.status) {
        throw new OrchestratorError("Current task snapshot is inconsistent during recovery", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      assertStateUpdate(currentState, journal.state, journal.task);
      await this.store.write(this.taskFile(projectId, taskId), journal.task);
    } else {
      throw new OrchestratorError("Task transition journal revision is stale or discontinuous", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    if (stableJson(currentState) !== stableJson(journal.state)) {
      await this.store.write(this.stateFile(projectId, taskId), journal.state);
    }
    await rm(path, { force: true });
  }

  private async acquireTaskLock(taskId: string): Promise<AcquiredLock> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        return await this.locks.acquire(`task:${taskId}`);
      } catch (error) {
        if (
          !(error instanceof OrchestratorError) ||
          error.code !== "TASK_STATE" ||
          Date.now() >= deadline
        ) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }
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

  private async readTask(projectId: string, taskId: string): Promise<Task> {
    const path = this.taskFile(projectId, taskId);
    const persisted = await this.store.read(path, persistedTaskSchema);
    if ("originalFeedbackSha256" in persisted) return taskSchema.parse(persisted);
    const expectedFeedbackPath = this.originalFeedbackPath(projectId, taskId);
    if (persisted.originalFeedbackPath !== expectedFeedbackPath) {
      throw new OrchestratorError("Legacy task feedback path is not state-owned", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const migrated = taskSchema.parse({
      ...persisted,
      originalFeedbackSha256: sha256(await readFile(expectedFeedbackPath)),
    });
    await this.store.write(path, migrated);
    return migrated;
  }
}

function assertStateUpdate(current: TaskStateDocument, next: TaskStateDocument, task: Task): void {
  if (next.taskId !== current.taskId || next.taskId !== task.id || next.status !== task.status) {
    throw new OrchestratorError("Task transition identities disagree", {
      code: "CONTEXT_INTEGRITY",
    });
  }
  if (next.status === current.status) {
    if (stableJson(next) !== stableJson(current)) {
      throw new OrchestratorError("Same-status task updates cannot rewrite state history", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    return;
  }
  if (!canTransitionTask(current.status, next.status)) {
    throw new OrchestratorError(
      `Invalid persisted task transition: ${current.status} -> ${next.status}`,
      {
        code: "TASK_STATE",
      },
    );
  }
  if (
    next.transitions.length !== current.transitions.length + 1 ||
    stableJson(next.transitions.slice(0, -1)) !== stableJson(current.transitions)
  ) {
    throw new OrchestratorError("Task transition history is not an exact extension", {
      code: "CONTEXT_INTEGRITY",
    });
  }
  const transition = next.transitions.at(-1);
  if (
    transition === undefined ||
    transition.previousState !== current.status ||
    transition.nextState !== next.status ||
    transition.timestamp !== next.updatedAt ||
    next.updatedAt !== task.updatedAt
  ) {
    throw new OrchestratorError("Task transition metadata is inconsistent", {
      code: "CONTEXT_INTEGRITY",
    });
  }
  const expectedResumableFrom =
    next.status === "blocked" || next.status === "cancelled"
      ? current.status === "blocked" || current.status === "cancelled"
        ? (current.resumableFrom ?? current.status)
        : current.status
      : undefined;
  if ((next.resumableFrom ?? null) !== (expectedResumableFrom ?? null)) {
    throw new OrchestratorError("Task resumable lineage is inconsistent", {
      code: "CONTEXT_INTEGRITY",
    });
  }
}

function assertCompleteStateHistory(
  state: TaskStateDocument,
  task: Task,
  requireTaskTimestamp: boolean,
): void {
  if (state.taskId !== task.id || state.status !== task.status) {
    throw new OrchestratorError("Task state history identity mismatch", {
      code: "CONTEXT_INTEGRITY",
    });
  }
  let currentStatus: Task["status"] = "created";
  let resumableFrom: Task["status"] | undefined;
  let priorTimestamp: string | undefined;
  for (const transition of state.transitions) {
    if (
      transition.previousState !== currentStatus ||
      !canTransitionTask(currentStatus, transition.nextState) ||
      (priorTimestamp !== undefined && transition.timestamp < priorTimestamp)
    ) {
      throw new OrchestratorError("Task state history contains a discontinuous transition", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    resumableFrom =
      transition.nextState === "blocked" || transition.nextState === "cancelled"
        ? currentStatus === "blocked" || currentStatus === "cancelled"
          ? (resumableFrom ?? currentStatus)
          : currentStatus
        : undefined;
    currentStatus = transition.nextState;
    priorTimestamp = transition.timestamp;
  }
  if (
    currentStatus !== state.status ||
    (state.resumableFrom ?? null) !== (resumableFrom ?? null) ||
    (priorTimestamp !== undefined && priorTimestamp !== state.updatedAt) ||
    (requireTaskTimestamp && state.updatedAt !== task.updatedAt)
  ) {
    throw new OrchestratorError("Task state history terminal lineage mismatch", {
      code: "CONTEXT_INTEGRITY",
    });
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
