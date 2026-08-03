import { z } from "zod";
import {
  acceptanceCriterionSchema,
  assumptionSchema,
  issueReportSchema,
  scopeDefinitionSchema,
} from "../../domain/task/task.js";
import { evidenceSchema } from "../../domain/evidence/evidence.js";
import { executionPhaseSchema } from "../../domain/execution/execution.js";

export const contextPackSchema = z
  .object({
    schemaVersion: z.literal(1),
    contextPackVersion: z.literal(2),
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
    taskBrief: z
      .object({
        title: z.string().min(1),
        summary: z.string().min(1),
        reports: z.array(issueReportSchema).min(1),
        assumptions: z.array(assumptionSchema),
        unknowns: z.array(z.string()),
        requestedScope: scopeDefinitionSchema,
      })
      .strict(),
    projectId: z.string(),
    sourceCommit: z.string(),
    worktreeHead: z.string().optional(),
    diagnosisHash: z.string().optional(),
    verificationHash: z.string().optional(),
    acceptanceCriteriaHash: z.string(),
    diffHash: z.string().optional(),
    diffPatch: z.string().optional(),
    verification: z.unknown().optional(),
    instructionHashes: z.array(z.object({ path: z.string(), sha256: z.string() }).strict()),
    selectedSkills: z
      .array(
        z
          .object({
            name: z.string().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/u),
            source: z.enum(["bundled", "project", "user"]),
            path: z.string().min(1),
            instructions: z.string().min(1).max(8_000),
            instructionsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict(),
      )
      .superRefine((skills, context) => {
        const names = new Set<string>();
        for (const skill of skills) {
          if (names.has(skill.name)) {
            context.addIssue({
              code: "custom",
              message: `Duplicate selected skill: ${skill.name}`,
            });
          }
          names.add(skill.name);
        }
      }),
    acceptanceCriteria: z.array(acceptanceCriterionSchema),
    constraints: z.array(z.string()),
    protectedContracts: z.array(z.string()),
    confirmedFacts: z.array(z.string()),
    confirmedCauses: z.array(z.string()),
    evidence: z.array(evidenceSchema),
    relevantFiles: z.array(z.string()),
    latestFailure: z.string().nullable(),
    expectedOutputSchema: z.record(z.string(), z.unknown()),
    contextPolicy: z
      .object({
        compacted: z.boolean(),
        threadRotated: z.literal(true),
        reasons: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    estimatedInputTokens: z.number().int().nonnegative(),
    estimateSource: z.literal("estimated"),
  })
  .strict();

export type ContextPack = z.infer<typeof contextPackSchema>;
