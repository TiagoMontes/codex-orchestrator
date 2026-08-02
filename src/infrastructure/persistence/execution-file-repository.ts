import { join } from "node:path";
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
}
