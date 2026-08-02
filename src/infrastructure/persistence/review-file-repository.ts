import { join } from "node:path";
import type { ReviewResult } from "../../domain/review/review.js";
import { reviewResultSchema } from "../../domain/review/review.js";
import type { StatePaths } from "./state-paths.js";
import { AtomicJsonStore } from "./atomic-json-store.js";

export class ReviewFileRepository {
  constructor(
    private readonly paths: StatePaths,
    private readonly store = new AtomicJsonStore(),
  ) {}

  async save(projectId: string, review: ReviewResult, executionId: string): Promise<string> {
    const taskDirectory = this.paths.taskDirectory(projectId, review.taskId);
    const parsed = reviewResultSchema.parse(review);
    const attemptPath = join(taskDirectory, "runs", `${executionId}.review.json`);
    await this.store.write(attemptPath, parsed);
    await this.store.write(join(taskDirectory, "review.json"), parsed);
    return attemptPath;
  }

  read(projectId: string, taskId: string): Promise<ReviewResult> {
    return this.store.read(
      join(this.paths.taskDirectory(projectId, taskId), "review.json"),
      reviewResultSchema,
    );
  }
}
