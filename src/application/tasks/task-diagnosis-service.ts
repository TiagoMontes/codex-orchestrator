import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
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
import { evidenceSchema, type Evidence } from "../../domain/evidence/evidence.js";
import { modelDecisionSchema, type ModelDecision } from "../../domain/execution/model-decision.js";
import { normalizedUsageSchema, type NormalizedUsage } from "../../domain/usage/usage.js";
import type { Task } from "../../domain/task/task.js";
import type { TaskStateDocument } from "../../domain/task/task-state.js";
import type { Project, VerificationCommand } from "../../domain/project/project.js";
import type {
  CodexProgressObserver,
  CodexRuntime,
} from "../../infrastructure/codex/codex-runtime.js";
import type { GitClient } from "../../infrastructure/git/git-client.js";
import { GitClientFactory } from "../../infrastructure/git/git-client-factory.js";
import { AtomicJsonStore } from "../../infrastructure/persistence/atomic-json-store.js";
import type { DecisionFileRepository } from "../../infrastructure/persistence/decision-file-repository.js";
import type { DiagnosisFileRepository } from "../../infrastructure/persistence/diagnosis-file-repository.js";
import type { EvidenceFileRepository } from "../../infrastructure/persistence/evidence-file-repository.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import type { UsageFileRepository } from "../../infrastructure/persistence/usage-file-repository.js";
import { FileLockManager } from "../../infrastructure/persistence/file-lock.js";
import { resolveSafePath } from "../../infrastructure/filesystem/path-safety.js";
import { PromptLoader } from "../../prompts/prompt-loader.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError, toOrchestratorError } from "../../shared/errors.js";
import { sha256, stableJson } from "../../shared/hashing.js";
import { ContextBudgetManager } from "../../orchestration/context/context-budget-manager.js";
import { ContextIntegrityValidator } from "../../orchestration/context/context-integrity-validator.js";
import { ContextPackBuilder } from "../../orchestration/context/context-pack-builder.js";
import { assertStructuredOutputBounded } from "../../orchestration/context/structured-output-bound.js";
import { TaskStateMachine } from "../../orchestration/engine/state-machine.js";
import { ModelRouter, type RoutingOverrides } from "../../orchestration/routing/model-router.js";
import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { PersistedTaskCancellation } from "./persisted-task-cancellation.js";
import { executionFailureStatus, taskFailureStatus } from "./task-failure-policy.js";
import { ParallelReadCoordinator } from "../../orchestration/parallel/parallel-read-coordinator.js";
import { planParallelReads } from "../../orchestration/parallel/parallel-read-planner.js";
import {
  assertRetryHasNewEvidence,
  executionInputFingerprint,
  latestFailureObservation,
} from "./execution-input-fingerprint.js";
import { semanticEvidenceInput } from "../../orchestration/context/evidence-fingerprint.js";
import { recoverInterruptedUsage } from "./interrupted-usage-recovery.js";
import { projectAtWorkingRoot } from "../projects/project-working-copy.js";
import {
  CommandRunner,
  type CommandRunResult,
} from "../../infrastructure/process/command-runner.js";

const diagnosisCheckpointSchema = z
  .object({
    schemaVersion: z.literal(1),
    executionId: z.string().uuid(),
    taskId: z.string().min(1),
    sourceCommit: z.string().min(1),
    baseFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    diagnosis: diagnosisSchema,
    evidence: z.array(evidenceSchema),
    modelDecision: modelDecisionSchema,
    usage: normalizedUsageSchema,
    threadId: z.string().min(1),
    runtimeAttempts: z.number().int().positive(),
    completedAt: z.string().datetime(),
  })
  .strict();

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
  progress?: CodexProgressObserver;
  abortSignal?: AbortSignal;
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
  private readonly gitClients: GitClientFactory;
  private readonly stateMachine = new TaskStateMachine();
  private readonly contextStore = new AtomicJsonStore();
  private readonly promptLoader = new PromptLoader();
  private readonly integrity = new ContextIntegrityValidator();
  private readonly skillRegistry = new SkillRegistry();
  private readonly operationLocks: FileLockManager;

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
  ) {
    this.operationLocks = new FileLockManager(paths.locksDirectory);
    this.gitClients = new GitClientFactory(paths);
  }

  async diagnose(taskId: string, overrides: DiagnosisOverrides = {}): Promise<DiagnosisRunReport> {
    const operationLock = await this.operationLocks.acquire(`task-operation:${taskId}`);
    try {
      try {
        return await this.diagnoseLocked(taskId, overrides);
      } catch (error) {
        let normalized = toOrchestratorError(error);
        const persisted = await this.tasks.getSnapshot(taskId).catch(() => undefined);
        if (persisted !== undefined) {
          await recoverInterruptedUsage(persisted.task, this.usage, this.executions).catch(
            () => undefined,
          );
          if (persisted.state.status === "cancelled") {
            normalized = new OrchestratorError("Task diagnosis was cancelled", {
              code: "CANCELLED",
              resumable: true,
              cause: error,
            });
          } else if (persisted.state.status === "diagnosing") {
            await this.failTask(persisted.task, persisted.state, normalized);
          }
        }
        throw normalized;
      }
    } finally {
      await operationLock.release();
    }
  }

  private async diagnoseLocked(
    taskId: string,
    overrides: DiagnosisOverrides,
  ): Promise<DiagnosisRunReport> {
    let { task, state } = await this.tasks.getSnapshot(taskId);
    if (state.status !== "ready-for-diagnosis") {
      throw new OrchestratorError(`Task ${taskId} cannot be diagnosed from state ${state.status}`, {
        code: "TASK_STATE",
        nextCommand: `cxo task status ${taskId}`,
      });
    }
    const project = await this.projects.inspect(task.projectId);
    const git = this.gitFor(task);
    const config = applyBudgetOverrides(await this.configService.load(), overrides, task.profile);
    const profile = overrides.profile ?? task.profile;
    const priorDiagnosisAttempts = (await this.executions.list(project.id, task.id)).filter(
      (attempt) => attempt.phase === "diagnosis",
    );
    const baseRef = overrides.baseRef ?? task.baseRef ?? project.baseRef;
    const sourceCommit = await git.resolveCommit(project.gitRoot, baseRef);
    const primarySnapshot = {
      head: await git.resolveCommit(project.gitRoot, "HEAD"),
      status: await git.statusPorcelain(project.gitRoot),
    };
    const diagnosisRoot = await this.prepareDiagnosisWorktree(project, task, sourceCommit, git);
    try {
      const diagnosisProject = await projectAtWorkingRoot(project, diagnosisRoot, sourceCommit);
      const selectedSkills = await this.skillRegistry.select({
        phase: "diagnosis",
        task,
        project: diagnosisProject,
      });
      const baseFingerprint = executionInputFingerprint({
        phase: "diagnosis",
        sourceCommit,
        task: diagnosisTaskInput(task),
        project: {
          id: diagnosisProject.id,
          baseRef: diagnosisProject.baseRef,
          verificationPolicy: diagnosisProject.verificationPolicy,
          instructionFiles: diagnosisProject.instructionFiles.map(({ relativePath, sha256 }) => ({
            relativePath,
            sha256,
          })),
        },
        selectedSkills: selectedSkills.map(({ name, source, sha256, instructionsSha256 }) => ({
          name,
          source,
          sha256,
          instructionsSha256,
        })),
      });
      const recovered = await this.replayCheckpoint({
        task,
        state,
        project: diagnosisProject,
        sourceCommit,
        baseRef,
        baseFingerprint,
        attempts: priorDiagnosisAttempts,
        config,
      });
      if (recovered !== undefined) return recovered;
      if (priorDiagnosisAttempts.length >= config.profiles[profile].maxDiagnosisAttempts) {
        throw new OrchestratorError("Diagnosis attempt limit reached", {
          code: "BUDGET",
          resumable: true,
        });
      }
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
      const evidence = await this.evidenceRepository.read(diagnosisProject.id, task.id);
      const reproductionEvidence = await this.runConfiguredReproduction({
        task,
        project: diagnosisProject,
        sourceCommit,
        workingDirectory: diagnosisRoot,
        executionId,
        config,
        ...(overrides.abortSignal === undefined ? {} : { abortSignal: overrides.abortSignal }),
      });
      evidence.push(...reproductionEvidence);
      if (reproductionEvidence.length > 0) {
        await this.evidenceRepository.merge(diagnosisProject.id, task.id, reproductionEvidence);
      }
      const parallelPlan = planParallelReads({
        task,
        requestedReaders: overrides.parallelReaders ?? 0,
        maximumReaders: Math.min(
          config.parallelism.maxParallelReaders,
          config.profiles[profile].maxParallelReaders,
        ),
      });
      if (overrides.parallelReaders !== undefined) {
        await this.decisions.append(project.id, task.id, {
          kind: "human",
          summary:
            parallelPlan.mode === "parallel"
              ? `Launching ${parallelPlan.workstreams.length} bounded read-only workers`
              : `Parallel readers disabled: ${parallelPlan.reason}`,
          details: {
            requestedReaders: overrides.parallelReaders,
            selectedReaders: parallelPlan.mode === "parallel" ? parallelPlan.workstreams.length : 0,
            reason: parallelPlan.reason,
          },
        });
      }
      const hasCompletedParallelRead = (await this.executions.list(project.id, task.id)).some(
        (attempt) => attempt.phase === "exploration" && attempt.status === "succeeded",
      );
      if (parallelPlan.mode === "parallel" && !hasCompletedParallelRead) {
        const parallelCancellation = new PersistedTaskCancellation(
          this.tasks,
          taskId,
          overrides.abortSignal,
        );
        try {
          const parallel = await new ParallelReadCoordinator(
            config,
            this.paths,
            this.runtime,
            this.usage,
            this.evidenceRepository,
            this.executions,
            this.decisions,
            this.clock,
          ).run({
            task,
            project: diagnosisProject,
            sourceCommit,
            profile,
            workstreams: parallelPlan.workstreams,
            workingDirectory: diagnosisRoot,
            overrides: {
              maxParallelReaders: parallelPlan.workstreams.length,
              ...(overrides.model === undefined ? {} : { model: overrides.model }),
              ...(overrides.reasoning === undefined ? {} : { reasoning: overrides.reasoning }),
              ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
              ...(overrides.progress === undefined ? {} : { progress: overrides.progress }),
              abortSignal: parallelCancellation.signal,
            },
          });
          evidence.push(...parallel.result.evidence);
        } finally {
          await parallelCancellation.dispose(overrides.abortSignal);
        }
      }
      const pack = new ContextPackBuilder(config).build({
        phase: "diagnosis",
        objective: `Diagnose ${task.title} without modifying the repository`,
        task,
        project: diagnosisProject,
        sourceCommit,
        evidence,
        relevantFiles: task.requestedScope.estimatedFiles,
        selectedSkills,
        outputSchema: toJsonSchema(diagnosisAgentResultSchema),
      });
      await this.integrity.assertLiveInstructionFiles(
        pack,
        { task, project: diagnosisProject, sourceCommit },
        diagnosisRoot,
      );
      const inputFingerprint = executionInputFingerprint({
        baseFingerprint,
        evidence: evidence.map(semanticEvidenceInput),
        priorFailure: latestFailureObservation(priorDiagnosisAttempts),
      });
      assertRetryHasNewEvidence(priorDiagnosisAttempts, inputFingerprint, "Diagnosis");
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
        activeParallelReaders: 0,
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
        attemptNumber: priorDiagnosisAttempts.length + 1,
        reservationId: admission.reservation.id,
        inputFingerprint,
        modelDecision,
        sandboxMode: "read-only",
        contextPackPath,
        inputEvidenceIds: evidence.map((item) => item.id),
        startedAt: timestamp,
        status: "running",
        eventsPath,
      };
      await this.executions.save(project.id, attempt);
      const cancellation = new PersistedTaskCancellation(this.tasks, taskId, overrides.abortSignal);
      let callStarted = false;

      try {
        const prompt = await this.promptLoader.render("diagnosis.prompt.md", {
          TASK_ID: task.id,
          SOURCE_COMMIT: sourceCommit,
          CONTEXT_PACK: stableJson(pack),
        });
        attempt = { ...attempt, callStartedAt: isoNow(this.clock) };
        await this.executions.save(project.id, attempt);
        callStarted = true;
        const runtimeResult = await this.runtime.runStructured({
          role: "diagnostician",
          prompt,
          workingDirectory: diagnosisRoot,
          model: modelDecision.model,
          reasoningPreset: modelDecision.reasoning,
          sandboxMode: "read-only",
          approvalPolicy: "never",
          networkAccessEnabled: overrides.allowNetwork ?? false,
          outputSchema: toJsonSchema(diagnosisAgentResultSchema),
          outputValidator: diagnosisAgentResultSchema,
          timeoutMs: overrides.timeoutMs ?? config.runtime.defaultTimeoutSeconds * 1_000,
          eventsPath,
          additionalAllowedEnvironmentNames: diagnosisProject.environmentPolicy.allowlist,
          explicitSecretEnvironmentExceptions: diagnosisProject.environmentPolicy.secretExceptions,
          ...(overrides.progress === undefined ? {} : { progress: overrides.progress }),
          abortSignal: cancellation.signal,
        });
        if (
          cancellation.signal.aborted ||
          (await this.tasks.getState(taskId)).status === "cancelled"
        ) {
          throw new OrchestratorError("Task diagnosis was cancelled", {
            code: "CANCELLED",
            resumable: true,
          });
        }
        const afterStatus = await git.statusPorcelain(diagnosisRoot);
        const afterHead = await git.resolveCommit(diagnosisRoot, "HEAD");
        if (afterStatus !== "" || afterHead !== sourceCommit) {
          throw new OrchestratorError("Detached worktree changed during read-only diagnosis", {
            code: "CONTEXT_INTEGRITY",
            resumable: true,
          });
        }
        assertStructuredOutputBounded(runtimeResult.output, config);
        const result = diagnosisAgentResultSchema.parse(runtimeResult.output);
        if (result.diagnosis.taskId !== task.id || result.diagnosis.sourceCommit !== sourceCommit) {
          throw new OrchestratorError("Diagnosis result identity or source commit mismatch", {
            code: "CONTEXT_INTEGRITY",
          });
        }
        if (result.evidence.length > config.context.maxEvidenceItems) {
          throw new OrchestratorError("Diagnosis returned too many evidence items", {
            code: "BUDGET",
            resumable: true,
          });
        }
        const diagnosisEvidence = await this.validateEvidence(
          result.evidence,
          task,
          diagnosisRoot,
          sourceCommit,
        );
        const validatedEvidence = deduplicateEvidence([...evidence, ...diagnosisEvidence]);
        if (validatedEvidence.length > config.context.maxEvidenceItems) {
          throw new OrchestratorError("Diagnosis evidence exceeds the configured bound", {
            code: "BUDGET",
            resumable: true,
          });
        }
        assertEvidenceReferences(result.diagnosis, validatedEvidence);
        const diagnosis = diagnosisSchema.parse(result.diagnosis);
        assertDiagnosisBounds(diagnosis, config);
        if (
          (await git.resolveCommit(diagnosisRoot, "HEAD")) !== sourceCommit ||
          (await git.statusPorcelain(diagnosisRoot)) !== ""
        ) {
          throw new OrchestratorError(
            "Detached worktree changed while diagnosis evidence was validated",
            {
              code: "CONTEXT_INTEGRITY",
              resumable: true,
            },
          );
        }
        const completion = isoNow(this.clock);
        await this.contextStore.write(this.diagnosisCheckpointPath(task, executionId), {
          schemaVersion: 1,
          executionId,
          taskId: task.id,
          sourceCommit,
          baseFingerprint,
          inputFingerprint,
          diagnosis,
          evidence: validatedEvidence,
          modelDecision,
          usage: runtimeResult.usage,
          threadId: runtimeResult.threadId,
          runtimeAttempts: runtimeResult.runtimeAttempts,
          completedAt: completion,
        });
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
        const nextStatus = diagnosis.status === "blocked" ? "blocked" : "diagnosed";
        attempt = {
          ...attempt,
          threadId: runtimeResult.threadId,
          completedAt: completion,
          status: diagnosis.status === "blocked" ? "blocked" : "succeeded",
          usage: runtimeResult.usage,
          resultArtifactPath: diagnosisPath,
        };
        await this.executions.save(project.id, attempt);
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
        return {
          task,
          diagnosis,
          evidence: validatedEvidence,
          modelDecision,
          usage: runtimeResult.usage,
          executionId,
        };
      } catch (error) {
        await (
          !callStarted
            ? this.usage.releaseReservation(project.id, task.id, admission.reservation.id)
            : this.usage.commitFailedReservation({
                projectId: project.id,
                taskId: task.id,
                reservationId: admission.reservation.id,
                model: modelDecision.model,
                reasoning: modelDecision.reasoning,
              })
        ).catch(() => undefined);
        let normalized = toOrchestratorError(error);
        const { task: persistedTask, state: persistedState } = await this.tasks.getSnapshot(taskId);
        if (persistedState.status === "cancelled") {
          normalized = new OrchestratorError("Task diagnosis was cancelled", {
            code: "CANCELLED",
            resumable: true,
            cause: error,
          });
        }
        const failedAt = isoNow(this.clock);
        attempt = {
          ...attempt,
          completedAt: failedAt,
          status: executionFailureStatus(normalized),
          error: {
            name: normalized.name,
            message: normalized.message,
            code: normalized.code,
            resumable: normalized.resumable,
          },
        };
        await this.executions.save(project.id, attempt);
        if (persistedState.status !== "cancelled") {
          const nextState = taskFailureStatus(normalized);
          state = this.stateMachine.transition(persistedState, {
            nextState,
            timestamp: failedAt,
            reason: normalized.message,
            actor: "system",
            executionId,
          });
          task = {
            ...persistedTask,
            status: nextState,
            revision: persistedTask.revision + 1,
            updatedAt: failedAt,
          };
          await this.tasks.update(task, state);
        }
        throw normalized;
      } finally {
        await cancellation.dispose(overrides.abortSignal);
      }
    } finally {
      await this.cleanupDiagnosisWorktree(project, diagnosisRoot, primarySnapshot, git);
    }
  }

  private async prepareDiagnosisWorktree(
    project: Project,
    task: Task,
    sourceCommit: string,
    git: GitClient,
  ): Promise<string> {
    await this.paths.ensureBaseDirectories();
    const target = await resolveSafePath(
      this.paths.worktreesDirectory,
      join(this.paths.worktreesDirectory, project.id, `${task.id}-diagnosis-${randomUUID()}`),
      { allowMissing: true },
    );
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await git.createDetachedWorktree(project.gitRoot, target, sourceCommit);
      const safeTarget = await resolveSafePath(this.paths.worktreesDirectory, target);
      const [head, status] = await Promise.all([
        git.resolveCommit(safeTarget, "HEAD"),
        git.statusPorcelain(safeTarget),
      ]);
      const registered = (await git.listWorktrees(project.gitRoot)).find(
        (worktree) => worktree.path === safeTarget,
      );
      if (
        head !== sourceCommit ||
        status !== "" ||
        registered === undefined ||
        !registered.detached
      ) {
        throw new OrchestratorError("Detached diagnosis worktree failed integrity validation", {
          code: "CONTEXT_INTEGRITY",
          resumable: true,
        });
      }
      return safeTarget;
    } catch (error) {
      await git.removeWorktree(project.gitRoot, target, true).catch(() => undefined);
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async runConfiguredReproduction(input: {
    task: Task;
    project: Project;
    sourceCommit: string;
    workingDirectory: string;
    executionId: string;
    config: AppConfig;
    abortSignal?: AbortSignal;
  }): Promise<Evidence[]> {
    const commands = deduplicateCommands(
      input.project.verificationPolicy.focused.filter((command) => command.approved),
    );
    if (commands.length === 0) return [];
    const runner = new CommandRunner(input.config, this.clock);
    const git = this.gitFor(input.task);
    const evidence: Evidence[] = [];
    for (const [index, command] of commands.entries()) {
      await this.assertDiagnosisWorktreeClean(input.workingDirectory, input.sourceCommit, git);
      const result = await runner.run({
        argv: command.argv,
        cwd: input.workingDirectory,
        timeoutMs: command.timeoutSeconds * 1_000,
        logPath: join(
          this.paths.taskDirectory(input.project.id, input.task.id),
          "logs",
          `diagnosis-reproduction-${input.executionId}-${index + 1}.log`,
        ),
        additionalAllowedEnvironmentNames: input.project.environmentPolicy.allowlist,
        explicitSecretEnvironmentExceptions: input.project.environmentPolicy.secretExceptions,
        ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      });
      await this.assertDiagnosisWorktreeClean(input.workingDirectory, input.sourceCommit, git);
      if (result.aborted) {
        throw new OrchestratorError("Configured diagnosis reproduction was cancelled", {
          code: "CANCELLED",
          resumable: true,
        });
      }
      evidence.push(
        reproductionEvidence(
          input.task,
          input.sourceCommit,
          command,
          result,
          index,
          input.config.context.maxExcerptCharacters,
        ),
      );
    }
    return evidence;
  }

  private async assertDiagnosisWorktreeClean(
    workingDirectory: string,
    sourceCommit: string,
    git: GitClient,
  ): Promise<void> {
    const [head, status] = await Promise.all([
      git.resolveCommit(workingDirectory, "HEAD"),
      git.statusPorcelain(workingDirectory),
    ]);
    if (head !== sourceCommit || status !== "") {
      throw new OrchestratorError("Configured reproduction changed the diagnosis worktree", {
        code: "CONTEXT_INTEGRITY",
        resumable: true,
      });
    }
  }

  private async cleanupDiagnosisWorktree(
    project: Project,
    diagnosisRoot: string,
    primarySnapshot: { head: string; status: string },
    git: GitClient,
  ): Promise<void> {
    let cleanupFailure: unknown;
    try {
      await git.removeWorktree(project.gitRoot, diagnosisRoot, true);
    } catch (error) {
      cleanupFailure = error;
    }
    const safeRoot = await resolveSafePath(this.paths.worktreesDirectory, diagnosisRoot, {
      allowMissing: true,
    });
    await rm(safeRoot, { recursive: true, force: true }).catch((error: unknown) => {
      cleanupFailure ??= error;
    });
    const [currentHead, currentStatus] = await Promise.all([
      git.resolveCommit(project.gitRoot, "HEAD"),
      git.statusPorcelain(project.gitRoot),
    ]);
    if (currentHead !== primarySnapshot.head || currentStatus !== primarySnapshot.status) {
      throw new OrchestratorError("Primary checkout changed during detached diagnosis", {
        code: "CONTEXT_INTEGRITY",
        resumable: true,
      });
    }
    if (cleanupFailure !== undefined) {
      throw new OrchestratorError("Detached diagnosis worktree cleanup failed", {
        code: "PROJECT",
        resumable: true,
        cause: cleanupFailure,
      });
    }
  }

  private async replayCheckpoint(input: {
    task: Task;
    state: TaskStateDocument;
    project: Awaited<ReturnType<ProjectManager["inspect"]>>;
    sourceCommit: string;
    baseRef: string;
    baseFingerprint: string;
    attempts: readonly ExecutionAttempt[];
    config: AppConfig;
  }): Promise<DiagnosisRunReport | undefined> {
    for (const attempt of [...input.attempts].reverse()) {
      if (
        attempt.status === "blocked" &&
        attempt.error === undefined &&
        attempt.resultArtifactPath !== undefined
      ) {
        continue;
      }
      const checkpointPath = this.diagnosisCheckpointPath(input.task, attempt.id);
      let checkpoint: z.infer<typeof diagnosisCheckpointSchema>;
      try {
        checkpoint = await this.contextStore.read(checkpointPath, diagnosisCheckpointSchema);
      } catch (error) {
        if (isMissingStateDocument(error)) continue;
        throw error;
      }
      if (
        checkpoint.executionId !== attempt.id ||
        checkpoint.taskId !== input.task.id ||
        checkpoint.sourceCommit !== input.sourceCommit ||
        checkpoint.baseFingerprint !== input.baseFingerprint ||
        checkpoint.inputFingerprint !== attempt.inputFingerprint
      ) {
        throw new OrchestratorError("Diagnosis recovery checkpoint is incompatible", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      if (checkpoint.evidence.length > input.config.context.maxEvidenceItems) {
        throw new OrchestratorError("Recovered diagnosis evidence exceeds its configured bound", {
          code: "BUDGET",
          resumable: true,
        });
      }
      const validatedEvidence = await this.validateEvidence(
        checkpoint.evidence,
        input.task,
        input.project.gitRoot,
        input.sourceCommit,
      );
      assertEvidenceReferences(checkpoint.diagnosis, validatedEvidence);
      assertDiagnosisBounds(checkpoint.diagnosis, input.config);
      const diagnosisPath = await this.diagnoses.save(input.project.id, checkpoint.diagnosis);
      await this.evidenceRepository.save(input.project.id, input.task.id, validatedEvidence);
      if (attempt.reservationId !== undefined) {
        await this.usage.commitReservation({
          projectId: input.project.id,
          taskId: input.task.id,
          reservationId: attempt.reservationId,
          model: checkpoint.modelDecision.model,
          reasoning: checkpoint.modelDecision.reasoning,
          usage: checkpoint.usage,
          agentCalls: checkpoint.runtimeAttempts,
          threadId: checkpoint.threadId,
        });
      }
      const { error: priorError, ...withoutError } = attempt;
      void priorError;
      await this.executions.save(input.project.id, {
        ...withoutError,
        completedAt: checkpoint.completedAt,
        status: checkpoint.diagnosis.status === "blocked" ? "blocked" : "succeeded",
        threadId: checkpoint.threadId,
        usage: checkpoint.usage,
        resultArtifactPath: diagnosisPath,
      });
      const startedAt = isoNow(this.clock);
      let state = this.stateMachine.transition(input.state, {
        nextState: "diagnosing",
        timestamp: startedAt,
        reason: `Recovered validated diagnosis checkpoint at ${input.sourceCommit}`,
        actor: "system",
        executionId: attempt.id,
      });
      let task: Task = {
        ...input.task,
        status: "diagnosing",
        baseRef: input.baseRef,
        baseCommit: input.sourceCommit,
        revision: input.task.revision + 1,
        updatedAt: startedAt,
      };
      await this.tasks.update(task, state);
      const nextStatus = checkpoint.diagnosis.status === "blocked" ? "blocked" : "diagnosed";
      const completedAt = isoNow(this.clock);
      state = this.stateMachine.transition(state, {
        nextState: nextStatus,
        timestamp: completedAt,
        reason: "Finalized persisted diagnosis checkpoint without another agent call",
        actor: "system",
        executionId: attempt.id,
      });
      task = {
        ...task,
        status: nextStatus,
        revision: task.revision + 1,
        updatedAt: completedAt,
      };
      await this.tasks.update(task, state);
      return {
        task,
        diagnosis: checkpoint.diagnosis,
        evidence: validatedEvidence,
        modelDecision: checkpoint.modelDecision,
        usage: checkpoint.usage,
        executionId: attempt.id,
      };
    }
    return undefined;
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
        const repositoryPath = relative(gitRoot, path);
        const contents = await this.gitFor(task).showFileBufferAtCommit(
          gitRoot,
          sourceCommit,
          repositoryPath,
        );
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
          file: repositoryPath,
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

  private async failTask(
    task: Task,
    state: TaskStateDocument,
    error: OrchestratorError,
  ): Promise<void> {
    const timestamp = isoNow(this.clock);
    const status = taskFailureStatus(error);
    const failed = this.stateMachine.transition(state, {
      nextState: status,
      timestamp,
      reason: error.message,
      actor: "system",
    });
    await this.tasks.update(
      { ...task, status, revision: task.revision + 1, updatedAt: timestamp },
      failed,
    );
  }

  private contextPackPath(task: Task, executionId: string): string {
    return `${this.paths.taskDirectory(task.projectId, task.id)}/context-packs/diagnosis-${executionId}.json`;
  }

  private eventsPath(task: Task, executionId: string): string {
    return `${this.paths.taskDirectory(task.projectId, task.id)}/logs/diagnosis-${executionId}.jsonl`;
  }

  private diagnosisCheckpointPath(task: Task, executionId: string): string {
    return `${this.paths.taskDirectory(task.projectId, task.id)}/runs/${executionId}.diagnosis-result.json`;
  }

  private gitFor(task: Pick<Task, "projectId" | "id">): GitClient {
    return this.gitClients.task(task.projectId, task.id, { phase: "diagnosis" });
  }
}

function diagnosisTaskInput(task: Task): unknown {
  return {
    id: task.id,
    projectId: task.projectId,
    type: task.type,
    title: task.title,
    summary: task.summary,
    reports: task.reports,
    constraints: task.constraints,
    acceptanceCriteria: task.acceptanceCriteria,
    protectedContracts: task.protectedContracts,
    assumptions: task.assumptions,
    unknowns: task.unknowns,
    requestedScope: task.requestedScope,
    profile: task.profile,
  };
}

function assertDiagnosisBounds(diagnosis: Diagnosis, config: AppConfig): void {
  if (
    diagnosis.affectedFiles.length > config.context.maxRelevantFiles ||
    diagnosis.implementationPlan.length > config.context.maxRelevantFiles ||
    diagnosis.verificationPlan.length > 64
  ) {
    throw new OrchestratorError("Diagnosis plan exceeds configured structural bounds", {
      code: "BUDGET",
      resumable: true,
    });
  }
}

function isMissingStateDocument(error: unknown): boolean {
  return (
    error instanceof OrchestratorError &&
    error.code === "CONFIGURATION" &&
    error.message.startsWith("Unable to read state document at ")
  );
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

function deduplicateEvidence(items: readonly Evidence[]): Evidence[] {
  const byId = new Map<string, Evidence>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function deduplicateCommands(commands: readonly VerificationCommand[]): VerificationCommand[] {
  const seen = new Set<string>();
  return commands.filter((command) => {
    const key = stableJson(command.argv);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reproductionEvidence(
  task: Task,
  sourceCommit: string,
  command: VerificationCommand,
  result: CommandRunResult,
  index: number,
  maximumExcerptCharacters: number,
): Evidence {
  const outcome =
    result.spawnError !== undefined || result.sandboxError !== undefined
      ? "was blocked"
      : result.timedOut
        ? "timed out"
        : result.exitCode === 0
          ? "passed"
          : `exited ${result.exitCode ?? "without a status"}`;
  const excerpt = [result.excerpt, result.spawnError, result.sandboxError]
    .filter((value): value is string => value !== undefined && value !== "")
    .join("\n")
    .slice(-maximumExcerptCharacters);
  return evidenceSchema.parse({
    id: `DR-${index + 1}-${sha256(
      stableJson({ taskId: task.id, sourceCommit, argv: command.argv }),
    ).slice(0, 12)}`,
    taskId: task.id,
    kind: command.name.toLowerCase().includes("test") ? "test" : "command",
    status: "confirmed",
    statement: `Configured diagnosis reproduction ${command.name} ${outcome}`,
    sourceCommit,
    command: command.argv.join(" "),
    ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
    excerpt,
    artifactPath: result.logPath,
    sha256: result.logSha256,
    observedAt: result.completedAt,
  });
}
