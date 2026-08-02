import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { z } from "zod";
import type {
  AppConfig,
  ExecutionProfile,
  ReasoningPreset,
} from "../configuration/config-schema.js";
import type { ConfigService } from "../configuration/config-service.js";
import type { ProjectManager } from "../projects/project-service.js";
import type { Diagnosis } from "../../domain/diagnosis/diagnosis.js";
import { diagnosisAgentResultSchema, diagnosisSchema } from "../../domain/diagnosis/diagnosis.js";
import type { Evidence } from "../../domain/evidence/evidence.js";
import type { ModelDecision } from "../../domain/execution/model-decision.js";
import type { NormalizedUsage } from "../../domain/usage/usage.js";
import type { Task } from "../../domain/task/task.js";
import type { TaskStateDocument } from "../../domain/task/task-state.js";
import type { CodexRuntime } from "../../infrastructure/codex/codex-runtime.js";
import { GitClient } from "../../infrastructure/git/git-client.js";
import { AtomicJsonStore } from "../../infrastructure/persistence/atomic-json-store.js";
import type { DecisionFileRepository } from "../../infrastructure/persistence/decision-file-repository.js";
import type { DiagnosisFileRepository } from "../../infrastructure/persistence/diagnosis-file-repository.js";
import type { EvidenceFileRepository } from "../../infrastructure/persistence/evidence-file-repository.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import type { UsageFileRepository } from "../../infrastructure/persistence/usage-file-repository.js";
import { resolveSafePath } from "../../infrastructure/filesystem/path-safety.js";
import { PromptLoader } from "../../prompts/prompt-loader.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError, toOrchestratorError } from "../../shared/errors.js";
import { sha256, stableJson } from "../../shared/hashing.js";
import { ContextBudgetManager } from "../../orchestration/context/context-budget-manager.js";
import { ContextIntegrityValidator } from "../../orchestration/context/context-integrity-validator.js";
import { ContextPackBuilder } from "../../orchestration/context/context-pack-builder.js";
import { TaskStateMachine } from "../../orchestration/engine/state-machine.js";
import { ModelRouter, type RoutingOverrides } from "../../orchestration/routing/model-router.js";
import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";

export type DiagnosisOverrides = {
  profile?: ExecutionProfile;
  model?: string;
  reasoning?: ReasoningPreset;
  maxTotalTokens?: number;
  maxAgentCalls?: number;
  parallelReaders?: number;
  allowNetwork?: boolean;
  baseRef?: string;
  timeoutMs?: number;
};

export type DiagnosisRunReport = {
  task: Task;
  diagnosis: Diagnosis;
  evidence: Evidence[];
  modelDecision: ModelDecision;
  usage: NormalizedUsage;
  executionId: string;
};

export interface TaskDiagnosisManager {
  diagnose(taskId: string, overrides?: DiagnosisOverrides): Promise<DiagnosisRunReport>;
}

export class TaskDiagnosisService implements TaskDiagnosisManager {
  private readonly git = new GitClient();
  private readonly stateMachine = new TaskStateMachine();
  private readonly contextStore = new AtomicJsonStore();
  private readonly promptLoader = new PromptLoader();
  private readonly integrity = new ContextIntegrityValidator();

  constructor(
    private readonly configService: ConfigService,
    private readonly paths: StatePaths,
    private readonly tasks: TaskFileRepository,
    private readonly projects: ProjectManager,
    private readonly runtime: CodexRuntime,
    private readonly usage: UsageFileRepository,
    private readonly diagnoses: DiagnosisFileRepository,
    private readonly evidenceRepository: EvidenceFileRepository,
    private readonly executions: ExecutionFileRepository,
    private readonly decisions: DecisionFileRepository,
    private readonly clock: Clock = systemClock,
  ) {}

  async diagnose(taskId: string, overrides: DiagnosisOverrides = {}): Promise<DiagnosisRunReport> {
    let task = await this.tasks.get(taskId);
    let state = await this.tasks.getState(taskId);
    if (state.status !== "ready-for-diagnosis") {
      throw new OrchestratorError(`Task ${taskId} cannot be diagnosed from state ${state.status}`, {
        code: "TASK_STATE",
        nextCommand: `cxo task status ${taskId}`,
      });
    }
    const project = await this.projects.inspect(task.projectId);
    const config = applyBudgetOverrides(await this.configService.load(), overrides, task.profile);
    const profile = overrides.profile ?? task.profile;
    const baseRef = overrides.baseRef ?? task.baseRef ?? project.baseRef;
    const sourceCommit = await this.git.resolveCommit(project.gitRoot, baseRef);
    const currentHead = await this.git.resolveCommit(project.gitRoot, "HEAD");
    if (sourceCommit !== currentHead) {
      await this.blockTask(
        task,
        state,
        `Source commit mismatch: ${sourceCommit} != ${currentHead}`,
      );
      throw new OrchestratorError(
        "Diagnosis source commit does not match the primary checkout HEAD",
        {
          code: "CONTEXT_INTEGRITY",
          resumable: true,
          nextCommand: `cxo project refresh ${project.id}`,
        },
      );
    }
    const beforeStatus = await this.git.statusPorcelain(project.gitRoot);
    const timestamp = isoNow(this.clock);
    state = this.stateMachine.transition(state, {
      nextState: "diagnosing",
      timestamp,
      reason: `Read-only diagnosis started at ${sourceCommit}`,
      actor: "system",
    });
    task = {
      ...task,
      status: "diagnosing",
      baseRef,
      baseCommit: sourceCommit,
      revision: task.revision + 1,
      updatedAt: timestamp,
    };
    await this.tasks.update(task, state);

    const executionId = randomUUID();
    const evidence: Evidence[] = [];
    const pack = new ContextPackBuilder(config).build({
      phase: "diagnosis",
      objective: `Diagnose ${task.title} without modifying the repository`,
      task,
      project,
      sourceCommit,
      evidence,
      relevantFiles: task.requestedScope.estimatedFiles,
      outputSchema: toJsonSchema(diagnosisAgentResultSchema),
    });
    await this.integrity.assertLiveInstructionFiles(pack, { task, project, sourceCommit });
    const contextPackPath = this.contextPackPath(task, executionId);
    await this.contextStore.write(contextPackPath, pack);
    const currentLedger = await this.usage.read(project.id, task.id);
    const maxTokens = config.profiles[profile].maxTotalTokens;
    const remainingBudget = Math.max(0, maxTokens - currentLedger.totals.totalTokens);
    const estimatedCallTokens = pack.estimatedInputTokens + config.context.reservedOutputTokens;
    const routingOverrides: RoutingOverrides = {
      ...(overrides.model === undefined ? {} : { model: overrides.model }),
      ...(overrides.reasoning === undefined ? {} : { reasoning: overrides.reasoning }),
    };
    const modelDecision = new ModelRouter(config).route({
      phase: "diagnosis",
      task,
      profile,
      estimatedCallTokens,
      remainingBudgetTokens: remainingBudget,
      overrides: routingOverrides,
    });
    const admission = await new ContextBudgetManager(config, this.usage).admitAndReserve({
      projectId: project.id,
      taskId: task.id,
      phase: "diagnosis",
      profile,
      estimatedInputTokens: pack.estimatedInputTokens,
      activeParallelReaders: overrides.parallelReaders ?? 0,
      projectedAgentCalls: 2,
    });
    await this.decisions.append(project.id, task.id, {
      kind: "model-routing",
      summary: `${modelDecision.model} / ${modelDecision.reasoning} selected for diagnosis`,
      details: modelDecision,
    });
    if (overrides.allowNetwork ?? false) {
      await this.decisions.append(project.id, task.id, {
        kind: "network-opt-in",
        summary: "Network access explicitly enabled for diagnosis",
        details: { phase: "diagnosis", executionId },
      });
    }
    const eventsPath = this.eventsPath(task, executionId);
    let attempt: ExecutionAttempt = {
      schemaVersion: 1,
      id: executionId,
      taskId: task.id,
      phase: "diagnosis",
      attemptNumber: 1,
      modelDecision,
      sandboxMode: "read-only",
      contextPackPath,
      inputEvidenceIds: [],
      startedAt: timestamp,
      status: "running",
      eventsPath,
    };
    await this.executions.save(project.id, attempt);

    try {
      const prompt = await this.promptLoader.render("diagnosis.prompt.md", {
        TASK_ID: task.id,
        SOURCE_COMMIT: sourceCommit,
        CONTEXT_PACK: stableJson(pack),
      });
      const runtimeResult = await this.runtime.runStructured({
        role: "diagnostician",
        prompt,
        workingDirectory: project.gitRoot,
        model: modelDecision.model,
        reasoningPreset: modelDecision.reasoning,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: overrides.allowNetwork ?? false,
        outputSchema: toJsonSchema(diagnosisAgentResultSchema),
        outputValidator: diagnosisAgentResultSchema,
        timeoutMs: overrides.timeoutMs ?? config.runtime.defaultTimeoutSeconds * 1_000,
        eventsPath,
      });
      const afterStatus = await this.git.statusPorcelain(project.gitRoot);
      const afterHead = await this.git.resolveCommit(project.gitRoot, "HEAD");
      if (afterStatus !== beforeStatus || afterHead !== sourceCommit) {
        throw new OrchestratorError("Repository changed during read-only diagnosis", {
          code: "CONTEXT_INTEGRITY",
          resumable: true,
        });
      }
      const result = diagnosisAgentResultSchema.parse(runtimeResult.output);
      if (result.diagnosis.taskId !== task.id || result.diagnosis.sourceCommit !== sourceCommit) {
        throw new OrchestratorError("Diagnosis result identity or source commit mismatch", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const validatedEvidence = await this.validateEvidence(
        result.evidence,
        task,
        project.gitRoot,
        sourceCommit,
      );
      assertEvidenceReferences(result.diagnosis, validatedEvidence);
      const diagnosis = diagnosisSchema.parse(result.diagnosis);
      const diagnosisPath = await this.diagnoses.save(project.id, diagnosis);
      await this.evidenceRepository.save(project.id, task.id, validatedEvidence);
      await this.usage.commitReservation({
        projectId: project.id,
        taskId: task.id,
        reservationId: admission.reservation.id,
        model: modelDecision.model,
        reasoning: modelDecision.reasoning,
        usage: runtimeResult.usage,
        agentCalls: runtimeResult.runtimeAttempts,
        threadId: runtimeResult.threadId,
      });
      const completion = isoNow(this.clock);
      const nextStatus = diagnosis.status === "blocked" ? "blocked" : "diagnosed";
      state = this.stateMachine.transition(state, {
        nextState: nextStatus,
        timestamp: completion,
        reason:
          diagnosis.status === "blocked"
            ? `Diagnosis blocked: ${diagnosis.nextAction}`
            : `Diagnosis persisted with status ${diagnosis.status}`,
        actor: "agent",
        executionId,
      });
      task = { ...task, status: nextStatus, revision: task.revision + 1, updatedAt: completion };
      await this.tasks.update(task, state);
      attempt = {
        ...attempt,
        threadId: runtimeResult.threadId,
        completedAt: completion,
        status: diagnosis.status === "blocked" ? "blocked" : "succeeded",
        usage: runtimeResult.usage,
        resultArtifactPath: diagnosisPath,
      };
      await this.executions.save(project.id, attempt);
      return {
        task,
        diagnosis,
        evidence: validatedEvidence,
        modelDecision,
        usage: runtimeResult.usage,
        executionId,
      };
    } catch (error) {
      await this.usage
        .releaseReservation(project.id, task.id, admission.reservation.id)
        .catch(() => undefined);
      const normalized = toOrchestratorError(error);
      const failedAt = isoNow(this.clock);
      attempt = {
        ...attempt,
        completedAt: failedAt,
        status: normalized.code === "CANCELLED" ? "cancelled" : "blocked",
        error: {
          name: normalized.name,
          message: normalized.message,
          code: normalized.code,
          resumable: normalized.resumable,
        },
      };
      await this.executions.save(project.id, attempt);
      const nextState = normalized.code === "CANCELLED" ? "cancelled" : "blocked";
      state = this.stateMachine.transition(state, {
        nextState,
        timestamp: failedAt,
        reason: normalized.message,
        actor: "system",
        executionId,
      });
      task = { ...task, status: nextState, revision: task.revision + 1, updatedAt: failedAt };
      await this.tasks.update(task, state);
      throw normalized;
    }
  }

  private async validateEvidence(
    evidence: readonly Evidence[],
    task: Task,
    gitRoot: string,
    sourceCommit: string,
  ): Promise<Evidence[]> {
    return Promise.all(
      evidence.map(async (item) => {
        if (item.taskId !== task.id || item.sourceCommit !== sourceCommit) {
          throw new OrchestratorError(`Evidence identity mismatch: ${item.id}`, {
            code: "CONTEXT_INTEGRITY",
          });
        }
        if (item.file === undefined) return item;
        const path = await resolveSafePath(gitRoot, item.file);
        const contents = await readFile(path);
        const text = contents.toString("utf8");
        const lines = text.split(/\r?\n/u);
        const start = item.startLine ?? 1;
        const end = item.endLine ?? Math.min(start, lines.length);
        if (start > lines.length || end > lines.length) {
          throw new OrchestratorError(`Evidence line range is outside ${item.file}`, {
            code: "CONTEXT_INTEGRITY",
          });
        }
        return {
          ...item,
          file: relative(gitRoot, path),
          startLine: start,
          endLine: end,
          excerpt: lines
            .slice(start - 1, end)
            .join("\n")
            .slice(0, 4_000),
          sha256: sha256(contents),
        };
      }),
    );
  }

  private async blockTask(task: Task, state: TaskStateDocument, reason: string): Promise<void> {
    const timestamp = isoNow(this.clock);
    const blocked = this.stateMachine.transition(state, {
      nextState: "blocked",
      timestamp,
      reason,
      actor: "system",
    });
    await this.tasks.update(
      { ...task, status: "blocked", revision: task.revision + 1, updatedAt: timestamp },
      blocked,
    );
  }

  private contextPackPath(task: Task, executionId: string): string {
    return `${this.paths.taskDirectory(task.projectId, task.id)}/context-packs/diagnosis-${executionId}.json`;
  }

  private eventsPath(task: Task, executionId: string): string {
    return `${this.paths.taskDirectory(task.projectId, task.id)}/logs/diagnosis-${executionId}.jsonl`;
  }
}

function applyBudgetOverrides(
  config: AppConfig,
  overrides: DiagnosisOverrides,
  taskProfile: ExecutionProfile,
): AppConfig {
  const profile = overrides.profile ?? taskProfile;
  return {
    ...config,
    profiles: {
      ...config.profiles,
      [profile]: {
        ...config.profiles[profile],
        ...(overrides.maxTotalTokens === undefined
          ? {}
          : { maxTotalTokens: overrides.maxTotalTokens }),
        ...(overrides.maxAgentCalls === undefined
          ? {}
          : { maxAgentCalls: overrides.maxAgentCalls }),
      },
    },
  };
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema);
  if (converted === null || Array.isArray(converted) || typeof converted !== "object") {
    throw new OrchestratorError("Unable to create JSON Schema for diagnosis output", {
      code: "CONFIGURATION",
    });
  }
  return converted;
}

function assertEvidenceReferences(diagnosis: Diagnosis, evidence: readonly Evidence[]): void {
  const available = new Set(evidence.map((item) => item.id));
  const referenced = [
    ...diagnosis.reproduction.evidenceIds,
    ...diagnosis.confirmedFacts.flatMap((fact) => fact.evidenceIds),
    ...diagnosis.rootCauses.flatMap((cause) => cause.evidenceIds),
    ...diagnosis.rejectedHypotheses.flatMap((hypothesis) => hypothesis.evidenceIds),
  ];
  const missing = [...new Set(referenced.filter((id) => !available.has(id)))];
  if (missing.length > 0) {
    throw new OrchestratorError(`Diagnosis references missing evidence: ${missing.join(", ")}`, {
      code: "CONTEXT_INTEGRITY",
    });
  }
}
