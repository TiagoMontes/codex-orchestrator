import { join } from "node:path";
import type { StatePaths } from "./state-paths.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { diagnosisSchema, type Diagnosis } from "../../domain/diagnosis/diagnosis.js";

export class DiagnosisFileRepository {
  constructor(
    private readonly paths: StatePaths,
    private readonly store = new AtomicJsonStore(),
  ) {}

  path(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "diagnosis.json");
  }

  async save(projectId: string, diagnosis: Diagnosis): Promise<string> {
    const path = this.path(projectId, diagnosis.taskId);
    await this.store.write(path, diagnosisSchema.parse(diagnosis));
    return path;
  }

  read(projectId: string, taskId: string): Promise<Diagnosis> {
    return this.store.read(this.path(projectId, taskId), diagnosisSchema);
  }
}
