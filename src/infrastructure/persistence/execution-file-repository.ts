import { access, constants, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { StatePaths } from "./state-paths.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { FileLockManager } from "./file-lock.js";
import {
  executionAttemptSchema,
  type ExecutionAttempt,
} from "../../domain/execution/execution-attempt.js";

export class ExecutionFileRepository {
  private readonly locks: FileLockManager;
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: StatePaths,
    private readonly store = new AtomicJsonStore(),
  ) {
    this.locks = new FileLockManager(paths.locksDirectory);
  }

  path(projectId: string, taskId: string, executionId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "runs", `${executionId}.json`);
  }

  save(projectId: string, attempt: ExecutionAttempt): Promise<string> {
    const operation = this.saveQueue.then(
      async () => this.saveLocked(projectId, attempt),
      async () => this.saveLocked(projectId, attempt),
    );
    this.saveQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async saveLocked(projectId: string, attempt: ExecutionAttempt): Promise<string> {
    const lock = await this.locks.acquire(`executions:${attempt.taskId}`);
    try {
      const path = this.path(projectId, attempt.taskId, attempt.id);
      const existing = (await exists(path))
        ? await this.store.read(path, executionAttemptSchema)
        : undefined;
      const sequence =
        existing === undefined
          ? await this.nextSequence(projectId, attempt.taskId)
          : existing.sequence;
      await this.store.write(
        path,
        executionAttemptSchema.parse({
          ...attempt,
          ...(sequence === undefined ? {} : { sequence }),
        }),
      );
      return path;
    } finally {
      await lock.release();
    }
  }

  read(projectId: string, taskId: string, executionId: string): Promise<ExecutionAttempt> {
    return this.store.read(this.path(projectId, taskId, executionId), executionAttemptSchema);
  }

  async list(projectId: string, taskId: string): Promise<ExecutionAttempt[]> {
    const directory = join(this.paths.taskDirectory(projectId, taskId), "runs");
    if (!(await exists(directory))) return [];
    const filenames = (await readdir(directory)).filter((name) => UUID_JSON.test(name)).sort();
    const attempts = await Promise.all(
      filenames.map(async (name) => this.read(projectId, taskId, basename(name, ".json"))),
    );
    return attempts.sort((left, right) => {
      if (left.sequence !== undefined || right.sequence !== undefined) {
        if (left.sequence === undefined) return -1;
        if (right.sequence === undefined) return 1;
        if (left.sequence !== right.sequence) return left.sequence - right.sequence;
      }
      return (
        left.startedAt.localeCompare(right.startedAt) ||
        left.attemptNumber - right.attemptNumber ||
        left.id.localeCompare(right.id)
      );
    });
  }

  private async nextSequence(projectId: string, taskId: string): Promise<number> {
    const attempts = await this.list(projectId, taskId);
    return Math.max(0, ...attempts.map((attempt) => attempt.sequence ?? 0)) + 1;
  }
}

const UUID_JSON =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
