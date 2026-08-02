import { access, constants, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import type { StatePaths } from "./state-paths.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import {
  executionAttemptSchema,
  type ExecutionAttempt,
} from "../../domain/execution/execution-attempt.js";

export class ExecutionFileRepository {
  constructor(
    private readonly paths: StatePaths,
    private readonly store = new AtomicJsonStore(),
  ) {}

  path(projectId: string, taskId: string, executionId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "runs", `${executionId}.json`);
  }

  async save(projectId: string, attempt: ExecutionAttempt): Promise<string> {
    const path = this.path(projectId, attempt.taskId, attempt.id);
    await this.store.write(path, executionAttemptSchema.parse(attempt));
    return path;
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
    return attempts.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
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
