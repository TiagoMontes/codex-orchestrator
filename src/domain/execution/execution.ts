import { z } from "zod";

export const executionPhaseSchema = z.enum([
  "normalization",
  "exploration",
  "diagnosis",
  "implementation",
  "verification",
  "review",
  "correction",
  "audit",
]);

export type ExecutionPhase = z.infer<typeof executionPhaseSchema>;
