import { z } from "zod";

export const normalizedUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteInputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningOutputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    source: z.enum(["actual", "estimated"]),
  })
  .strict();

export type NormalizedUsage = z.infer<typeof normalizedUsageSchema>;

export const ZERO_ESTIMATED_USAGE: NormalizedUsage = {
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  source: "estimated",
};
