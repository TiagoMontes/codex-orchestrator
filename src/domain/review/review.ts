import { z } from "zod";

export const reviewFindingSchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum(["critical", "high", "medium", "low"]),
    category: z.enum([
      "correctness",
      "security",
      "regression",
      "contract",
      "test-gap",
      "scope",
      "maintainability",
    ]),
    title: z.string().min(1),
    explanation: z.string().min(1),
    file: z.string().min(1).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    reproduction: z.array(z.string()).optional(),
    evidenceIds: z.array(z.string()),
    recommendation: z.string().min(1),
  })
  .strict()
  .refine(
    (finding) =>
      finding.startLine === undefined ||
      finding.endLine === undefined ||
      finding.endLine >= finding.startLine,
    { message: "Finding endLine must not precede startLine", path: ["endLine"] },
  );

export const reviewResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    reviewedDiffHash: z.string().regex(/^[a-f0-9]{64}$/u),
    verdict: z.enum(["approve", "changes-requested", "blocked"]),
    findings: z.array(reviewFindingSchema),
    acceptanceCriteriaAssessment: z.array(
      z
        .object({
          criterionId: z.string().min(1),
          status: z.enum(["met", "not-met", "uncertain"]),
          evidenceIds: z.array(z.string()),
          explanation: z.string().min(1),
        })
        .strict(),
    ),
    scopeAssessment: z
      .object({
        withinScope: z.boolean(),
        unexpectedFiles: z.array(z.string()),
        explanation: z.string().min(1),
      })
      .strict(),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((review, context) => {
    if (new Set(review.findings.map((finding) => finding.id)).size !== review.findings.length) {
      context.addIssue({ code: "custom", message: "Review finding IDs must be unique" });
    }
    const criterionIds = review.acceptanceCriteriaAssessment.map((item) => item.criterionId);
    if (new Set(criterionIds).size !== criterionIds.length) {
      context.addIssue({ code: "custom", message: "Criterion assessments must be unique" });
    }
  });

export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;
