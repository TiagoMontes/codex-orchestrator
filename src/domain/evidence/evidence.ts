import { z } from "zod";

export const evidenceSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    kind: z.enum(["file", "symbol", "git", "command", "test", "log", "review", "user"]),
    status: z.enum(["confirmed", "rejected", "unverified"]),
    statement: z.string().min(1),
    sourceCommit: z.string().min(1),
    file: z.string().min(1).optional(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    symbol: z.string().min(1).optional(),
    command: z.string().min(1).optional(),
    exitCode: z.number().int().optional(),
    excerpt: z.string().optional(),
    artifactPath: z.string().min(1).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    observedAt: z.string().datetime(),
  })
  .strict()
  .refine(
    (value) =>
      value.startLine === undefined ||
      value.endLine === undefined ||
      value.endLine >= value.startLine,
    { message: "Evidence endLine must not precede startLine", path: ["endLine"] },
  );

export type Evidence = z.infer<typeof evidenceSchema>;
