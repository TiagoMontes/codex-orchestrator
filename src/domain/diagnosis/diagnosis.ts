import { z } from "zod";
import { evidenceSchema } from "../evidence/evidence.js";

export const planStepSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    files: z.array(z.string()),
    risk: z.string(),
  })
  .strict();

export const verificationStepSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    argv: z.array(z.string()).min(1),
    expectedOutcome: z.string().min(1),
  })
  .strict();

export const diagnosisSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    sourceCommit: z.string().min(1),
    status: z.enum(["confirmed", "partially-confirmed", "not-reproduced", "blocked"]),
    reproduction: z
      .object({
        attempted: z.boolean(),
        reproduced: z.boolean(),
        steps: z.array(z.string()),
        blockers: z.array(z.string()),
        evidenceIds: z.array(z.string()),
      })
      .strict(),
    confirmedFacts: z.array(
      z.object({ statement: z.string().min(1), evidenceIds: z.array(z.string()).min(1) }).strict(),
    ),
    rootCauses: z.array(
      z
        .object({
          statement: z.string().min(1),
          confidence: z.enum(["high", "medium", "low"]),
          evidenceIds: z.array(z.string()).min(1),
        })
        .strict(),
    ),
    activeHypotheses: z.array(
      z.object({ statement: z.string().min(1), nextCheck: z.string().min(1) }).strict(),
    ),
    rejectedHypotheses: z.array(
      z
        .object({
          statement: z.string().min(1),
          reason: z.string().min(1),
          evidenceIds: z.array(z.string()),
        })
        .strict(),
    ),
    affectedFiles: z.array(
      z
        .object({
          path: z.string().min(1),
          reason: z.string().min(1),
          symbols: z.array(z.string()),
        })
        .strict(),
    ),
    risks: z.array(z.string()),
    implementationPlan: z.array(planStepSchema),
    verificationPlan: z.array(verificationStepSchema),
    nextAction: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((diagnosis, context) => {
    const evidenceIds = new Set([
      ...diagnosis.reproduction.evidenceIds,
      ...diagnosis.confirmedFacts.flatMap((fact) => fact.evidenceIds),
      ...diagnosis.rootCauses.flatMap((cause) => cause.evidenceIds),
      ...diagnosis.rejectedHypotheses.flatMap((hypothesis) => hypothesis.evidenceIds),
    ]);
    if (diagnosis.status === "confirmed" && diagnosis.rootCauses.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Confirmed diagnosis requires at least one root cause",
      });
    }
    if (diagnosis.confirmedFacts.length > 0 && evidenceIds.size === 0) {
      context.addIssue({ code: "custom", message: "Confirmed facts require evidence IDs" });
    }
  });

export const diagnosisAgentResultSchema = z
  .object({
    diagnosis: diagnosisSchema,
    evidence: z.array(evidenceSchema),
  })
  .strict();

export type Diagnosis = z.infer<typeof diagnosisSchema>;
export type DiagnosisAgentResult = z.infer<typeof diagnosisAgentResultSchema>;
export type PlanStep = z.infer<typeof planStepSchema>;
export type VerificationStep = z.infer<typeof verificationStepSchema>;
