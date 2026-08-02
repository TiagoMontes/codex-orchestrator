import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { ConfigService } from "../configuration/config-service.js";
import { taskDraftSchema, type TaskDraft } from "../../domain/task/task.js";
import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";
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
import { ContextBudgetManager } from "../../orchestration/context/context-budget-manager.js";
import { ContextSizer } from "../../orchestration/context/context-sizer.js";
import { ModelRouter } from "../../orchestration/routing/model-router.js";
import type { TaskNormalizationRequest, TaskNormalizer } from "./task-normalizer.js";
import { executionFailureStatus } from "./task-failure-policy.js";

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
    const projectedTokens = estimate.estimatedTokens + config.context.reservedOutputTokens;
    const decision = new ModelRouter(config).route({
      phase: "normalization",
      profile: request.profile,
      estimatedCallTokens: projectedTokens,
      remainingBudgetTokens: configuredLimits.maxTotalTokens,
    });
    const admission = await new ContextBudgetManager(config, this.usage).admitAndReserve({
      projectId: request.projectId,
      taskId: request.taskId,
      phase: "normalization",
      profile: request.profile,
      estimatedInputTokens: estimate.estimatedTokens,
      activeParallelReaders: 0,
      projectedAgentCalls: 2,
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
    let execution: ExecutionAttempt = {
      schemaVersion: 1,
      id: executionId,
      taskId: request.taskId,
      phase: "normalization",
      attemptNumber: 1,
      modelDecision: decision,
      sandboxMode: "read-only",
      contextPackPath,
      inputEvidenceIds: [],
      startedAt: isoNow(this.clock),
      status: "running",
      eventsPath,
    };
    await this.executions.save(request.projectId, execution);
    await this.decisions.append(request.projectId, request.taskId, {
      kind: "model-routing",
      summary: `${decision.model} / ${decision.reasoning} selected for normalization`,
      details: decision,
    });
    try {
      const prompt = await this.promptLoader.render("normalizer.prompt.md", {
        TASK_ID: request.taskId,
        PROJECT_ID: request.projectId,
        ORIGINAL_FEEDBACK: JSON.stringify(request.originalFeedback),
      });
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
        ...(request.abortSignal === undefined ? {} : { abortSignal: request.abortSignal }),
      });
      const draft = taskDraftSchema.parse(result.output);
      const resultPath = join(
        this.paths.taskDirectory(request.projectId, request.taskId),
        "runs",
        `${executionId}.normalization.json`,
      );
      await this.store.write(resultPath, draft);
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
        completedAt: isoNow(this.clock),
        status: "succeeded",
        usage: result.usage,
        resultArtifactPath: resultPath,
      };
      await this.executions.save(request.projectId, execution);
      return draft;
    } catch (error) {
      await this.usage
        .releaseReservation(request.projectId, request.taskId, admission.reservation.id)
        .catch(() => undefined);
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
