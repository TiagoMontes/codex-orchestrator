import { z } from "zod";
import { evidenceSchema } from "../../domain/evidence/evidence.js";

export const readWorkerResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    workerId: z.string().min(1),
    taskId: z.string().min(1),
    sourceCommit: z.string().min(1),
    summary: z.string().min(1),
    evidence: z.array(evidenceSchema),
  })
  .strict();

export const consolidatedReadResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    sourceCommit: z.string().min(1),
    coordinatorId: z.string().uuid(),
    workerIds: z.array(z.string()),
    summaries: z.array(z.object({ workerId: z.string(), summary: z.string() }).strict()),
    evidence: z.array(evidenceSchema),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ReadWorkerResult = z.infer<typeof readWorkerResultSchema>;
export type ConsolidatedReadResult = z.infer<typeof consolidatedReadResultSchema>;
