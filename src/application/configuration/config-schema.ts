import { z } from "zod";

export const executionProfileSchema = z.enum(["economy", "balanced", "quality", "critical"]);
export type ExecutionProfile = z.infer<typeof executionProfileSchema>;

export const reasoningPresetSchema = z.enum(["minimal", "low", "medium", "high", "deepest"]);
export type ReasoningPreset = z.infer<typeof reasoningPresetSchema>;

export const sdkReasoningEffortSchema = z.enum(["minimal", "low", "medium", "high", "xhigh"]);

const modelAliasSchema = z.enum(["capable", "efficient", "fast"]);

const routingRuleSchema = z
  .object({
    modelAlias: modelAliasSchema,
    reasoning: reasoningPresetSchema,
  })
  .strict();

export const profileLimitsSchema = z
  .object({
    maxTotalTokens: z.number().int().positive(),
    maxAgentCalls: z.number().int().positive(),
    maxTurnsPerThread: z.number().int().positive(),
    maxDiagnosisAttempts: z.number().int().positive(),
    maxImplementationAttempts: z.number().int().positive(),
    maxReviewCycles: z.number().int().positive(),
    maxParallelReaders: z.number().int().nonnegative(),
    allowCapableModel: z.boolean(),
    allowDeepestReasoning: z.boolean(),
  })
  .strict();

export const appConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultProfile: executionProfileSchema,
    models: z
      .object({
        aliases: z
          .object({
            capable: z.string().min(1),
            efficient: z.string().min(1),
            fast: z.string().min(1),
          })
          .strict(),
        reasoningFallback: z
          .object({
            deepest: z.array(sdkReasoningEffortSchema).min(1),
            high: z.array(sdkReasoningEffortSchema).min(1),
            medium: z.array(sdkReasoningEffortSchema).min(1),
            low: z.array(sdkReasoningEffortSchema).min(1),
            minimal: z.array(sdkReasoningEffortSchema).min(1),
          })
          .strict(),
      })
      .strict(),
    routing: z
      .object({
        normalization: routingRuleSchema,
        cheapClassification: routingRuleSchema,
        repositoryExploration: routingRuleSchema,
        standardDiagnosis: routingRuleSchema,
        complexDiagnosis: routingRuleSchema,
        standardImplementation: routingRuleSchema,
        complexImplementation: routingRuleSchema,
        independentReview: routingRuleSchema,
        criticalReview: routingRuleSchema,
      })
      .strict(),
    profiles: z
      .object({
        economy: profileLimitsSchema,
        balanced: profileLimitsSchema,
        quality: profileLimitsSchema,
        critical: profileLimitsSchema,
      })
      .strict(),
    runtime: z
      .object({
        networkAccessEnabled: z.boolean(),
        webSearchMode: z.literal("disabled"),
        approvalPolicy: z.literal("never"),
        nativeCodexSubagents: z.literal(false),
        defaultTimeoutSeconds: z.number().int().positive(),
      })
      .strict(),
    context: z
      .object({
        estimatedInputSoftLimit: z.number().int().positive(),
        estimatedInputHardLimit: z.number().int().positive(),
        reservedOutputTokens: z.number().int().positive(),
        maxRelevantFiles: z.number().int().positive(),
        maxEvidenceItems: z.number().int().positive(),
        maxErrorExcerpts: z.number().int().positive(),
        maxReviewFindings: z.number().int().positive(),
        maxExcerptCharacters: z.number().int().positive(),
        tokenEstimateSafetyMultiplier: z.number().min(1),
        includeFullConversation: z.literal(false),
        includeFullLogs: z.literal(false),
      })
      .strict()
      .refine((value) => value.estimatedInputHardLimit >= value.estimatedInputSoftLimit, {
        message: "estimatedInputHardLimit must be at least estimatedInputSoftLimit",
        path: ["estimatedInputHardLimit"],
      }),
    parallelism: z
      .object({
        enabled: z.boolean(),
        maxDepth: z.literal(1),
        allowNestedAgents: z.literal(false),
        readOnlyOnly: z.literal(true),
        oneWriterOnly: z.literal(true),
        sharedTaskBudget: z.literal(true),
        nativeCodexSubagents: z.literal(false),
      })
      .strict(),
    storage: z
      .object({
        home: z.string().min(1).nullable(),
        maxCommandLogBytes: z.number().int().positive(),
        maxEventLogBytes: z.number().int().positive(),
        lockStaleAfterSeconds: z.number().int().positive(),
      })
      .strict(),
    security: z
      .object({
        allowNetworkByDefault: z.literal(false),
        allowDangerFullAccess: z.literal(false),
        environmentAllowlist: z.array(z.string().min(1)),
      })
      .strict(),
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;
