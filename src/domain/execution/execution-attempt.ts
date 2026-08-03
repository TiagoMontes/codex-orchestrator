import { z } from "zod";
import { executionPhaseSchema } from "./execution.js";
import { modelDecisionSchema } from "./model-decision.js";
import { normalizedUsageSchema } from "../usage/usage.js";

export const serializableErrorSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    code: z.string().optional(),
    resumable: z.boolean(),
  })
  .strict();

export const executionAttemptSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().uuid(),
    taskId: z.string(),
    phase: executionPhaseSchema,
    attemptNumber: z.number().int().positive(),
    sequence: z.number().int().positive().optional(),
    reservationId: z.string().uuid().optional(),
    baseInputFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    inputFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    threadId: z.string().optional(),
    modelDecision: modelDecisionSchema,
    sandboxMode: z.enum(["read-only", "workspace-write"]),
    contextPackPath: z.string(),
    inputEvidenceIds: z.array(z.string()),
    startedAt: z.string().datetime(),
    callStartedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
    status: z.enum(["running", "succeeded", "failed", "cancelled", "blocked"]),
    failureSignature: z.string().optional(),
    usage: normalizedUsageSchema.optional(),
    resultArtifactPath: z.string().optional(),
    eventsPath: z.string(),
    error: serializableErrorSchema.optional(),
  })
  .strict();

export type ExecutionAttempt = z.infer<typeof executionAttemptSchema>;
