import { z } from "zod";
import { executionPhaseSchema } from "../execution/execution.js";
import { normalizedUsageSchema } from "./usage.js";
import { reasoningPresetSchema } from "../../application/configuration/config-schema.js";

export const usageLedgerEntrySchema = z
  .object({
    id: z.string().uuid(),
    phase: executionPhaseSchema,
    model: z.string().min(1),
    reasoning: reasoningPresetSchema,
    threadId: z.string().min(1).optional(),
    workerId: z.string().min(1).optional(),
    agentCalls: z.number().int().positive(),
    usage: normalizedUsageSchema,
    recordedAt: z.string().datetime(),
  })
  .strict();

export const usageReservationSchema = z
  .object({
    id: z.string().uuid(),
    phase: executionPhaseSchema,
    projectedTokens: z.number().int().positive(),
    projectedCalls: z.number().int().positive(),
    workerId: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

export const usageLedgerDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    entries: z.array(usageLedgerEntrySchema),
    reservations: z.array(usageReservationSchema),
    totals: normalizedUsageSchema,
    totalCalls: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type UsageLedgerEntry = z.infer<typeof usageLedgerEntrySchema>;
export type UsageReservation = z.infer<typeof usageReservationSchema>;
export type UsageLedgerDocument = z.infer<typeof usageLedgerDocumentSchema>;
