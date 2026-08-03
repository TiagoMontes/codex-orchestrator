import { z } from "zod";
import { implementationResultSchema } from "../../domain/execution/implementation-result.js";
import { modelDecisionSchema } from "../../domain/execution/model-decision.js";
import { normalizedUsageSchema } from "../../domain/usage/usage.js";

/** Durable agent-call result written before any derived writer artifact or usage commit. */
export const writerRuntimeCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: z.string().uuid(),
    taskId: z.string().min(1),
    sourceCommit: z.string().min(1),
    baseCommit: z.string().min(1),
    kind: z.enum(["implementation", "review-correction"]),
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

export type WriterRuntimeCheckpoint = z.infer<typeof writerRuntimeCheckpointSchema>;
