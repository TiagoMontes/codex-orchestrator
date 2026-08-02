import { z } from "zod";
import { executionProfileSchema } from "../../application/configuration/config-schema.js";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const taskTypeSchema = z.enum([
  "bugfix",
  "feature",
  "refactor",
  "maintenance",
  "investigation",
  "review",
  "test",
  "documentation",
  "audit",
]);

export const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const taskStatusSchema = z.enum([
  "created",
  "normalizing",
  "ready-for-diagnosis",
  "diagnosing",
  "diagnosed",
  "worktree-preparing",
  "ready-for-implementation",
  "implementing",
  "verifying",
  "reviewing",
  "correcting",
  "completed",
  "blocked",
  "failed",
  "cancelled",
]);

export const issueReportSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    route: z.string().min(1).optional(),
    method: z.string().min(1).optional(),
    currentBehavior: z.string(),
    expectedBehavior: z.array(z.string()),
    payloads: z.array(jsonValueSchema),
    observedResponses: z.array(jsonValueSchema),
    errorMessages: z.array(z.string()),
    stackTraces: z.array(z.string()),
    environment: z.record(z.string(), z.string()),
    suspectedChanges: z.array(z.string()),
    reproductionNotes: z.array(z.string()),
  })
  .strict();

export const acceptanceCriterionSchema = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
    required: z.boolean(),
    source: z.enum(["user", "inferred"]),
  })
  .strict();

export const assumptionSchema = z
  .object({
    statement: z.string().min(1),
    provenance: z.enum(["user-hypothesis", "inferred-hypothesis"]),
    status: z.enum(["unverified", "confirmed", "rejected"]),
  })
  .strict();

export const scopeDefinitionSchema = z
  .object({
    included: z.array(z.string()),
    excluded: z.array(z.string()),
    estimatedFiles: z.array(z.string()),
  })
  .strict();

export const worktreeReferenceSchema = z
  .object({
    path: z.string().min(1),
    branch: z.string().min(1),
    baseCommit: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export const taskSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    id: z.string().min(1),
    projectId: z.string().min(1),
    parentTaskId: z.string().min(1).optional(),
    childTaskIds: z.array(z.string()),
    type: taskTypeSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    originalFeedbackPath: z.string().min(1),
    profile: executionProfileSchema,
    risk: riskLevelSchema,
    riskSignals: z.array(z.string()),
    status: taskStatusSchema,
    reports: z.array(issueReportSchema).min(1),
    constraints: z.array(z.string()),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
    protectedContracts: z.array(z.string()),
    assumptions: z.array(assumptionSchema),
    unknowns: z.array(z.string()),
    requestedScope: scopeDefinitionSchema,
    baseRef: z.string().min(1).optional(),
    baseCommit: z.string().min(1).optional(),
    worktree: worktreeReferenceSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

const taskDraftBaseSchema = z
  .object({
    type: taskTypeSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    reports: z.array(issueReportSchema).min(1),
    constraints: z.array(z.string()),
    acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
    protectedContracts: z.array(z.string()),
    assumptions: z.array(assumptionSchema),
    unknowns: z.array(z.string()),
    riskSignals: z.array(z.string()),
    suggestedScope: scopeDefinitionSchema,
  })
  .strict();

export const taskDraftSchema = taskDraftBaseSchema
  .extend({
    childTasks: z.array(taskDraftBaseSchema),
  })
  .strict();

export type Task = z.infer<typeof taskSchema>;
export type TaskType = z.infer<typeof taskTypeSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type TaskDraft = z.infer<typeof taskDraftSchema>;
export type TaskDraftBase = z.infer<typeof taskDraftBaseSchema>;
export type RiskLevel = z.infer<typeof riskLevelSchema>;
export type IssueReport = z.infer<typeof issueReportSchema>;
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
export type Assumption = z.infer<typeof assumptionSchema>;
export type ScopeDefinition = z.infer<typeof scopeDefinitionSchema>;
