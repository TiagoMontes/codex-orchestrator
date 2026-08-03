import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ConfigService } from "../configuration/config-service.js";
import { taskDraftSchema, type TaskDraft } from "../../domain/task/task.js";
import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";
import { modelDecisionSchema } from "../../domain/execution/model-decision.js";
import { normalizedUsageSchema } from "../../domain/usage/usage.js";
import type { CodexRuntime } from "../../infrastructure/codex/codex-runtime.js";
import { AtomicJsonStore } from "../../infrastructure/persistence/atomic-json-store.js";
import type { DecisionFileRepository } from "../../infrastructure/persistence/decision-file-repository.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import type { UsageFileRepository } from "../../infrastructure/persistence/usage-file-repository.js";
import { PromptLoader } from "../../prompts/prompt-loader.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError, toOrchestratorError } from "../../shared/errors.js";
import { stableJson } from "../../shared/hashing.js";
import { ContextBudgetManager } from "../../orchestration/context/context-budget-manager.js";
import { ContextSizer } from "../../orchestration/context/context-sizer.js";
import { assertStructuredOutputBounded } from "../../orchestration/context/structured-output-bound.js";
import { ModelRouter } from "../../orchestration/routing/model-router.js";
import type { TaskNormalizationRequest, TaskNormalizer } from "./task-normalizer.js";
import { executionFailureStatus } from "./task-failure-policy.js";
import {
  assertRetryHasNewEvidence,
  executionInputFingerprint,
  latestFailureObservation,
} from "./execution-input-fingerprint.js";

const normalizationCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: z.string().uuid(),
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    baseInputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    modelDecision: modelDecisionSchema,
    draft: taskDraftSchema,
    usage: normalizedUsageSchema,
    threadId: z.string().min(1),
    runtimeAttempts: z.number().int().positive(),
    completedAt: z.string().datetime(),
  })
  .strict();

export class CodexTaskNormalizer implements TaskNormalizer {
  private readonly promptLoader = new PromptLoader();
  private readonly store = new AtomicJsonStore();

  constructor(
    private readonly configService: ConfigService,
    private readonly paths: StatePaths,
    private readonly runtime: CodexRuntime,
    private readonly usage: UsageFileRepository,
    private readonly executions: ExecutionFileRepository,
    private readonly decisions: DecisionFileRepository,
    private readonly clock: Clock = systemClock,
  ) {}

  async normalize(request: TaskNormalizationRequest): Promise<TaskDraft> {
    const config = await this.configService.load();
    const input = {
      taskId: request.taskId,
      projectId: request.projectId,
      originalFeedback: request.originalFeedback,
      expectedOutputSchema: toJsonSchema(taskDraftSchema),
    };
    const estimate = new ContextSizer(config.context.tokenEstimateSafetyMultiplier).estimate(input);
    if (estimate.estimatedTokens > config.context.estimatedInputHardLimit) {
      throw new OrchestratorError("Task feedback exceeds the hard normalization context limit", {
        code: "BUDGET",
        resumable: true,
      });
    }
    const configuredLimits = config.profiles[request.profile];
    const baseFingerprint = executionInputFingerprint({
      phase: "normalization",
      projectId: request.projectId,
      taskId: request.taskId,
      originalFeedback: request.originalFeedback,
      outputSchema: input.expectedOutputSchema,
    });
    const existingAttempts = (await this.executions.list(request.projectId, request.taskId)).filter(
      (attempt) => attempt.phase === "normalization",
    );
    const replayed = await this.replayPersistedResult(request, existingAttempts, baseFingerprint);
    if (replayed !== undefined) return replayed;
    const fingerprint = executionInputFingerprint({
      baseFingerprint,
      priorFailure: latestFailureObservation(existingAttempts),
    });
    assertRetryHasNewEvidence(existingAttempts, fingerprint, "Normalization");
    const projectedTokens = estimate.estimatedTokens + config.context.reservedOutputTokens;
    const decision = new ModelRouter(config).route({
      phase: "normalization",
      profile: request.profile,
      estimatedCallTokens: projectedTokens,
      remainingBudgetTokens: configuredLimits.maxTotalTokens,
    });
    const executionId = randomUUID();
    const contextPackPath = join(
      this.paths.taskDirectory(request.projectId, request.taskId),
      "context-packs",
      `normalization-${executionId}.json`,
    );
    await this.store.write(contextPackPath, {
      schemaVersion: 1,
      phase: "normalization",
      taskId: request.taskId,
      projectId: request.projectId,
      estimatedInputTokens: estimate.estimatedTokens,
      estimateSource: estimate.source,
      feedbackCharacters: request.originalFeedback.length,
      expectedOutputSchema: input.expectedOutputSchema,
    });
    const eventsPath = join(
      this.paths.taskDirectory(request.projectId, request.taskId),
      "logs",
      `normalization-${executionId}.jsonl`,
    );
    const admission = await new ContextBudgetManager(config, this.usage).admitAndReserve({
      projectId: request.projectId,
      taskId: request.taskId,
      phase: "normalization",
      profile: request.profile,
      estimatedInputTokens: estimate.estimatedTokens,
      activeParallelReaders: 0,
      projectedAgentCalls: 2,
    });
    let execution: ExecutionAttempt = {
      schemaVersion: 1,
      id: executionId,
      taskId: request.taskId,
      phase: "normalization",
      attemptNumber: existingAttempts.length + 1,
      reservationId: admission.reservation.id,
      baseInputFingerprint: baseFingerprint,
      inputFingerprint: fingerprint,
      modelDecision: decision,
      sandboxMode: "read-only",
      contextPackPath,
      inputEvidenceIds: [],
      startedAt: isoNow(this.clock),
      status: "running",
      eventsPath,
    };
    try {
      await this.executions.save(request.projectId, execution);
    } catch (error) {
      await this.usage.releaseReservation(
        request.projectId,
        request.taskId,
        admission.reservation.id,
      );
      throw error;
    }
    let callStarted = false;
    try {
      await this.decisions.append(request.projectId, request.taskId, {
        kind: "model-routing",
        summary: `${decision.model} / ${decision.reasoning} selected for normalization`,
        details: decision,
      });
      const prompt = await this.promptLoader.render("normalizer.prompt.md", {
        TASK_ID: request.taskId,
        PROJECT_ID: request.projectId,
        ORIGINAL_FEEDBACK: JSON.stringify(request.originalFeedback),
      });
      execution = { ...execution, callStartedAt: isoNow(this.clock) };
      await this.executions.save(request.projectId, execution);
      callStarted = true;
      const result = await this.runtime.runStructured({
        role: "normalizer",
        prompt,
        workingDirectory: request.workingDirectory,
        model: decision.model,
        reasoningPreset: decision.reasoning,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        outputSchema: input.expectedOutputSchema,
        outputValidator: taskDraftSchema,
        timeoutMs: config.runtime.defaultTimeoutSeconds * 1_000,
        eventsPath,
        ...(request.additionalAllowedEnvironmentNames === undefined
          ? {}
          : { additionalAllowedEnvironmentNames: request.additionalAllowedEnvironmentNames }),
        ...(request.explicitSecretEnvironmentExceptions === undefined
          ? {}
          : {
              explicitSecretEnvironmentExceptions: request.explicitSecretEnvironmentExceptions,
            }),
        ...(request.progress === undefined ? {} : { progress: request.progress }),
        ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
      });
      assertStructuredOutputBounded(result.output, config);
      const draft = taskDraftSchema.parse(result.output);
      const resultPath = join(
        this.paths.taskDirectory(request.projectId, request.taskId),
        "runs",
        `${executionId}.normalization.json`,
      );
      const completedAt = isoNow(this.clock);
      await this.store.write(
        resultPath,
        normalizationCheckpointSchema.parse({
          schemaVersion: 1,
          executionId,
          taskId: request.taskId,
          projectId: request.projectId,
          baseInputFingerprint: baseFingerprint,
          inputFingerprint: fingerprint,
          modelDecision: decision,
          draft,
          usage: result.usage,
          threadId: result.threadId,
          runtimeAttempts: result.runtimeAttempts,
          completedAt,
        }),
      );
      await this.usage.commitReservation({
        projectId: request.projectId,
        taskId: request.taskId,
        reservationId: admission.reservation.id,
        model: decision.model,
        reasoning: decision.reasoning,
        usage: result.usage,
        agentCalls: result.runtimeAttempts,
        threadId: result.threadId,
      });
      execution = {
        ...execution,
        threadId: result.threadId,
        completedAt,
        status: "succeeded",
        usage: result.usage,
        resultArtifactPath: resultPath,
      };
      await this.executions.save(request.projectId, execution);
      return draft;
    } catch (error) {
      await (
        callStarted
          ? this.usage.commitFailedReservation({
              projectId: request.projectId,
              taskId: request.taskId,
              reservationId: admission.reservation.id,
              model: decision.model,
              reasoning: decision.reasoning,
            })
          : this.usage.releaseReservation(
              request.projectId,
              request.taskId,
              admission.reservation.id,
            )
      ).catch(() => undefined);
      const normalized = toOrchestratorError(error);
      execution = {
        ...execution,
        completedAt: isoNow(this.clock),
        status: executionFailureStatus(normalized),
        error: {
          name: normalized.name,
          message: normalized.message,
          code: normalized.code,
          resumable: normalized.resumable,
        },
      };
      await this.executions.save(request.projectId, execution);
      throw normalized;
    }
  }

  private async replayPersistedResult(
    request: TaskNormalizationRequest,
    attempts: readonly ExecutionAttempt[],
    baseFingerprint: string,
  ): Promise<TaskDraft | undefined> {
    let latest: ExecutionAttempt | undefined;
    let resultPath: string | undefined;
    for (const attempt of [...attempts].reverse()) {
      if (
        attempt.baseInputFingerprint !== baseFingerprint &&
        attempt.inputFingerprint !== baseFingerprint
      ) {
        continue;
      }
      const candidate = join(
        this.paths.taskDirectory(request.projectId, request.taskId),
        "runs",
        `${attempt.id}.normalization.json`,
      );
      try {
        await access(candidate, constants.R_OK);
      } catch {
        continue;
      }
      latest = attempt;
      resultPath = candidate;
      break;
    }
    if (latest === undefined || resultPath === undefined) return undefined;
    const checkpoint = await this.store.read(resultPath, normalizationCheckpointSchema);
    if (
      checkpoint.executionId !== latest.id ||
      checkpoint.taskId !== request.taskId ||
      checkpoint.projectId !== request.projectId ||
      checkpoint.baseInputFingerprint !== baseFingerprint ||
      checkpoint.inputFingerprint !== latest.inputFingerprint ||
      stableJson(checkpoint.modelDecision) !== stableJson(latest.modelDecision) ||
      latest.reservationId === undefined
    ) {
      throw new OrchestratorError("Normalization recovery checkpoint is incompatible", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    await this.usage.commitReservation({
      projectId: request.projectId,
      taskId: request.taskId,
      reservationId: latest.reservationId,
      model: checkpoint.modelDecision.model,
      reasoning: checkpoint.modelDecision.reasoning,
      usage: checkpoint.usage,
      agentCalls: checkpoint.runtimeAttempts,
      threadId: checkpoint.threadId,
    });
    const { error: priorError, ...withoutError } = latest;
    void priorError;
    await this.executions.save(request.projectId, {
      ...withoutError,
      completedAt: checkpoint.completedAt,
      status: "succeeded",
      resultArtifactPath: resultPath,
      threadId: checkpoint.threadId,
      usage: checkpoint.usage,
    });
    return checkpoint.draft;
  }
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema);
  if (converted === null || Array.isArray(converted) || typeof converted !== "object") {
    throw new OrchestratorError("Unable to create normalizer output schema", {
      code: "CONFIGURATION",
    });
  }
  return converted;
}
