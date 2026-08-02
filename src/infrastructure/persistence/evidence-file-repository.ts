import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { StatePaths } from "./state-paths.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { evidenceSchema, type Evidence } from "../../domain/evidence/evidence.js";
import { OrchestratorError } from "../../shared/errors.js";

const evidenceDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string(),
    items: z.array(evidenceSchema),
  })
  .strict();

export class EvidenceFileRepository {
  constructor(
    private readonly paths: StatePaths,
    private readonly store = new AtomicJsonStore(),
  ) {}

  async save(projectId: string, taskId: string, items: readonly Evidence[]): Promise<string> {
    if (items.some((item) => item.taskId !== taskId)) {
      throw new OrchestratorError("Evidence task identity mismatch", { code: "CONTEXT_INTEGRITY" });
    }
    const ids = new Set(items.map((item) => item.id));
    if (ids.size !== items.length) {
      throw new OrchestratorError("Evidence IDs must be unique", { code: "CONTEXT_INTEGRITY" });
    }
    const path = join(this.paths.taskDirectory(projectId, taskId), "evidence.json");
    await this.store.write(path, evidenceDocumentSchema.parse({ schemaVersion: 1, taskId, items }));
    return path;
  }

  async read(projectId: string, taskId: string): Promise<Evidence[]> {
    const path = join(this.paths.taskDirectory(projectId, taskId), "evidence.json");
    if (!(await exists(path))) return [];
    return (await this.store.read(path, evidenceDocumentSchema)).items;
  }

  async merge(projectId: string, taskId: string, items: readonly Evidence[]): Promise<string> {
    const path = join(this.paths.taskDirectory(projectId, taskId), "evidence.json");
    const existing = (await exists(path)) ? await this.read(projectId, taskId) : [];
    const byId = new Map(existing.map((item) => [item.id, item]));
    for (const item of items) byId.set(item.id, item);
    return this.save(
      projectId,
      taskId,
      [...byId.values()].sort((left, right) => left.id.localeCompare(right.id)),
    );
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
