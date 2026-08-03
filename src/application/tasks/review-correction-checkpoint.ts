import { z } from "zod";
import { implementationResultSchema } from "../../domain/execution/implementation-result.js";
import { modelDecisionSchema } from "../../domain/execution/model-decision.js";
import { normalizedUsageSchema } from "../../domain/usage/usage.js";

export const reviewCorrectionCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: z.string().uuid(),
    taskId: z.string().min(1),
    sourceCommit: z.string().min(1),
    baseCommit: z.string().min(1),
    preCorrectionDiffHash: z.string().regex(/^[a-f0-9]{64}$/u),
    postCorrectionDiffHash: z.string().regex(/^[a-f0-9]{64}$/u),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    modelDecision: modelDecisionSchema,
    implementation: implementationResultSchema,
    usage: normalizedUsageSchema,
    threadId: z.string().min(1),
    runtimeAttempts: z.number().int().positive(),
    resultArtifactPath: z.string().min(1),
    completedAt: z.string().datetime(),
  })
  .strict();

export type ReviewCorrectionCheckpoint = z.infer<typeof reviewCorrectionCheckpointSchema>;
