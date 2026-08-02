import { join } from "node:path";
import type { VerificationResult } from "../../domain/verification/verification.js";
import { verificationResultSchema } from "../../domain/verification/verification.js";
import type { StatePaths } from "./state-paths.js";
import { AtomicJsonStore } from "./atomic-json-store.js";

export class VerificationFileRepository {
  constructor(
    private readonly paths: StatePaths,
    private readonly store = new AtomicJsonStore(),
  ) {}

  async save(projectId: string, result: VerificationResult, executionId: string): Promise<string> {
    const taskDirectory = this.paths.taskDirectory(projectId, result.taskId);
    const parsed = verificationResultSchema.parse(result);
    const attemptPath = join(taskDirectory, "runs", `${executionId}.verification.json`);
    await this.store.write(attemptPath, parsed);
    await this.store.write(join(taskDirectory, "verification.json"), parsed);
    return attemptPath;
  }

  read(projectId: string, taskId: string): Promise<VerificationResult> {
    return this.store.read(
      join(this.paths.taskDirectory(projectId, taskId), "verification.json"),
      verificationResultSchema,
    );
  }
}
