import { z } from "zod";
import { acceptanceCriterionSchema } from "../../domain/task/task.js";
import { evidenceSchema } from "../../domain/evidence/evidence.js";
import { executionPhaseSchema } from "../../domain/execution/execution.js";

export const contextPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    contextPackVersion: z.literal(1),
    phase: executionPhaseSchema,
    objective: z.string().min(1),
    task: z
      .object({
        id: z.string(),
        schemaVersion: z.number().int().positive(),
        revision: z.number().int().positive(),
        hash: z.string(),
      })
      .strict(),
    projectId: z.string(),
    sourceCommit: z.string(),
    worktreeHead: z.string().optional(),
    diagnosisHash: z.string().optional(),
    acceptanceCriteriaHash: z.string(),
    diffHash: z.string().optional(),
    instructionHashes: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()),
    selectedSkills: z.array(z.object({ name: z.string(), sha256: z.string() }).strict()),
    acceptanceCriteria: z.array(acceptanceCriterionSchema),
    constraints: z.array(z.string()),
    protectedContracts: z.array(z.string()),
    confirmedFacts: z.array(z.string()),
    confirmedCauses: z.array(z.string()),
    evidence: z.array(evidenceSchema),
    relevantFiles: z.array(z.string()),
    latestFailure: z.string().nullable(),
    expectedOutputSchema: z.record(z.string(), z.unknown()),
    estimatedInputTokens: z.number().int().nonnegative(),
    estimateSource: z.literal("estimated"),
  })
  .strict();

export type ContextPack = z.infer<typeof contextPackSchema>;
