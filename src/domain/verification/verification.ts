import { z } from "zod";

export const verificationCommandResultSchema = z
  .object({
    name: z.string().min(1),
    argv: z.array(z.string()).min(1),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    exitCode: z.number().int().nullable(),
    signal: z.string().min(1).optional(),
    timedOut: z.boolean(),
    status: z.enum(["passed", "failed", "blocked"]),
    logPath: z.string().min(1),
    logSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    excerpt: z.string(),
    evidenceId: z.string().min(1),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === "passed" && (result.exitCode !== 0 || result.timedOut)) {
      context.addIssue({
        code: "custom",
        message: "A passed command must exit zero and must not time out",
      });
    }
  });

export const verificationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    diffHash: z.string().regex(/^[a-f0-9]{64}$/u),
    overallStatus: z.enum(["passed", "failed", "blocked"]),
    commands: z.array(verificationCommandResultSchema),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.overallStatus === "passed" && result.commands.length === 0) {
      context.addIssue({ code: "custom", message: "Verification cannot pass without commands" });
    }
    if (
      result.overallStatus === "passed" &&
      result.commands.some((command) => command.status !== "passed")
    ) {
      context.addIssue({
        code: "custom",
        message: "Passed verification contains a failed command",
      });
    }
  });

export type VerificationCommandResult = z.infer<typeof verificationCommandResultSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
