import { z } from "zod";
import {
  executionProfileSchema,
  reasoningPresetSchema,
} from "../../application/configuration/config-schema.js";
import { executionPhaseSchema } from "./execution.js";

export const modelDecisionSchema = z
  .object({
    schemaVersion: z.literal(1),
    phase: executionPhaseSchema,
    profile: executionProfileSchema,
    modelAlias: z.enum(["capable", "efficient", "fast"]).optional(),
    model: z.string().min(1),
    reasoning: reasoningPresetSchema,
    routingSignals: z.array(z.string()),
    reason: z.string().min(1),
    estimatedCallTokens: z.number().int().nonnegative(),
    remainingBudgetTokens: z.number().int().nonnegative(),
    manualOverrides: z
      .object({
        model: z.string().min(1).optional(),
        reasoning: reasoningPresetSchema.optional(),
      })
      .strict(),
    fallbackOrDowngrade: z.string().optional(),
  })
  .strict();

export type ModelDecision = z.infer<typeof modelDecisionSchema>;
