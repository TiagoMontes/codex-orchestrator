import { z } from "zod";

export const diffArtifactSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    worktreeHead: z.string().regex(/^[a-f0-9]{40,64}$/u),
    statusPorcelain: z.string(),
    changedFiles: z.array(z.string()),
    binaryFiles: z.array(z.string()),
    diffStat: z.string(),
    patchPath: z.string().min(1),
    diffHash: z.string().regex(/^[a-f0-9]{64}$/u),
    capturedAt: z.string().datetime(),
  })
  .strict();

export type DiffArtifact = z.infer<typeof diffArtifactSchema>;
