import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import type { StatePaths } from "./state-paths.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { FileLockManager } from "./file-lock.js";

export const decisionEntrySchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["model-routing", "network-opt-in", "reasoning-fallback", "escalation", "human"]),
    summary: z.string(),
    details: z.record(z.string(), z.unknown()),
    createdAt: z.string().datetime(),
  })
  .strict();

export const decisionDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string(),
    entries: z.array(decisionEntrySchema),
  })
  .strict();

export class DecisionFileRepository {
  private readonly locks: FileLockManager;

  constructor(
    private readonly paths: StatePaths,
    private readonly store = new AtomicJsonStore(),
    private readonly clock: Clock = systemClock,
  ) {
    this.locks = new FileLockManager(paths.locksDirectory);
  }

  async append(
    projectId: string,
    taskId: string,
    input: {
      kind: z.infer<typeof decisionEntrySchema>["kind"];
      summary: string;
      details: Record<string, unknown>;
    },
  ): Promise<void> {
    const lock = await this.locks.acquire(`decisions:${taskId}`);
    try {
      const path = this.path(projectId, taskId);
      const document = (await exists(path))
        ? await this.store.read(path, decisionDocumentSchema)
        : { schemaVersion: 1 as const, taskId, entries: [] };
      document.entries.push({
        id: randomUUID(),
        kind: input.kind,
        summary: input.summary,
        details: input.details,
        createdAt: isoNow(this.clock),
      });
      await this.store.write(path, decisionDocumentSchema.parse(document));
    } finally {
      await lock.release();
    }
  }

  async list(projectId: string, taskId: string): Promise<DecisionEntry[]> {
    const path = this.path(projectId, taskId);
    if (!(await exists(path))) return [];
    return (await this.store.read(path, decisionDocumentSchema)).entries;
  }

  private path(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "decisions.json");
  }
}

export type DecisionEntry = z.infer<typeof decisionEntrySchema>;

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
