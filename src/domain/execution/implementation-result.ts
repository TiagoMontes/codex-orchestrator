import { z } from "zod";

export const implementationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    status: z.enum(["changed", "no-change", "blocked"]),
    summary: z.string().min(1),
    advisoryChangedFiles: z.array(z.string()),
    testsAddedOrUpdated: z.array(z.string()),
    unresolvedRisks: z.array(z.string()),
    completedAt: z.string().datetime(),
  })
  .strict();

export type ImplementationResult = z.infer<typeof implementationResultSchema>;
