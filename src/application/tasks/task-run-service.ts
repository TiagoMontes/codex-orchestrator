import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type {
  AppConfig,
  ExecutionProfile,
  ReasoningPreset,
} from "../configuration/config-schema.js";
import type { ConfigService } from "../configuration/config-service.js";
import type { ProjectManager } from "../projects/project-service.js";
import type { Diagnosis } from "../../domain/diagnosis/diagnosis.js";
import type { DiffArtifact } from "../../domain/execution/diff-artifact.js";
import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";
import { implementationResultSchema } from "../../domain/execution/implementation-result.js";
import type { ModelDecision } from "../../domain/execution/model-decision.js";
import type { Task } from "../../domain/task/task.js";
import type { UsageLedgerDocument } from "../../domain/usage/usage-ledger.js";
import type { VerificationResult } from "../../domain/verification/verification.js";
import { reviewResultSchema } from "../../domain/review/review.js";
import type { CodexRuntime } from "../../infrastructure/codex/codex-runtime.js";
import { DiffService } from "../../infrastructure/git/diff-service.js";
import { GitClient } from "../../infrastructure/git/git-client.js";
import { GitCommandLog } from "../../infrastructure/git/git-command-log.js";
import { RepositoryLock } from "../../infrastructure/git/repository-lock.js";
import { WorktreeManager } from "../../infrastructure/git/worktree-manager.js";
import { AtomicFileWriter } from "../../infrastructure/persistence/atomic-file-writer.js";
import { AtomicJsonStore } from "../../infrastructure/persistence/atomic-json-store.js";
import type { DecisionFileRepository } from "../../infrastructure/persistence/decision-file-repository.js";
import type { DiagnosisFileRepository } from "../../infrastructure/persistence/diagnosis-file-repository.js";
import type { EvidenceFileRepository } from "../../infrastructure/persistence/evidence-file-repository.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import type { UsageFileRepository } from "../../infrastructure/persistence/usage-file-repository.js";
import type { VerificationFileRepository } from "../../infrastructure/persistence/verification-file-repository.js";
import { FileLockManager } from "../../infrastructure/persistence/file-lock.js";
import { PromptLoader } from "../../prompts/prompt-loader.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError, toOrchestratorError } from "../../shared/errors.js";
import { stableJson } from "../../shared/hashing.js";
import { ContextBudgetManager } from "../../orchestration/context/context-budget-manager.js";
import { ContextIntegrityValidator } from "../../orchestration/context/context-integrity-validator.js";
import { ContextPackBuilder } from "../../orchestration/context/context-pack-builder.js";
import { StopPolicy } from "../../orchestration/engine/stop-policy.js";
import { TaskStateMachine } from "../../orchestration/engine/state-machine.js";
import { EscalationPolicy } from "../../orchestration/routing/escalation-policy.js";
import { ModelRouter, type RoutingOverrides } from "../../orchestration/routing/model-router.js";
import type { TaskWorktreeService } from "./task-worktree-service.js";
import { VerificationService } from "./verification-service.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { PersistedTaskCancellation } from "./persisted-task-cancellation.js";

export type TaskRunOverrides = {
  profile?: ExecutionProfile;
  model?: string;
  reasoning?: ReasoningPreset;
  maxTotalTokens?: number;
  maxAgentCalls?: number;
  parallelReaders?: number;
  allowNetwork?: boolean;
  baseRef?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export type TaskRunReport = {
  task: Task;
  diff: DiffArtifact;
  verification: VerificationResult;
  attempts: ExecutionAttempt[];
  usage: UsageLedgerDocument;
};

export interface TaskRunner {
  run(taskId: string, overrides?: TaskRunOverrides): Promise<TaskRunReport>;
}

export class TaskRunService implements TaskRunner {
  private readonly stateMachine = new TaskStateMachine();
  private readonly stopPolicy = new StopPolicy();
  private readonly promptLoader = new PromptLoader();
  private readonly integrity = new ContextIntegrityValidator();
  private readonly store = new AtomicJsonStore();
  private readonly textWriter = new AtomicFileWriter();
  private readonly skillRegistry = new SkillRegistry();
  private readonly repositoryLock: RepositoryLock;
  private readonly operationLocks: FileLockManager;
  private readonly gitLog: GitCommandLog;

  constructor(
    private readonly configService: ConfigService,
    private readonly paths: StatePaths,
    private readonly tasks: TaskFileRepository,
    private readonly projects: ProjectManager,
    private readonly worktrees: TaskWorktreeService,
    private readonly runtime: CodexRuntime,
    private readonly usage: UsageFileRepository,
    private readonly diagnoses: DiagnosisFileRepository,
    private readonly evidenceRepository: EvidenceFileRepository,
    private readonly executions: ExecutionFileRepository,
    private readonly decisions: DecisionFileRepository,
    private readonly verificationRepository: VerificationFileRepository,
    private readonly clock: Clock = systemClock,
  ) {
    this.repositoryLock = new RepositoryLock(paths);
    this.operationLocks = new FileLockManager(paths.locksDirectory);
    this.gitLog = new GitCommandLog(paths);
  }

  async run(taskId: string, overrides: TaskRunOverrides = {}): Promise<TaskRunReport> {
    const operationLock = await this.operationLocks.acquire(`task-operation:${taskId}`);
    try {
      return await this.runLocked(taskId, overrides);
    } finally {
      await operationLock.release();
    }
  }

  private async runLocked(taskId: string, overrides: TaskRunOverrides): Promise<TaskRunReport> {
    let task = await this.tasks.get(taskId);
    if (
      task.status === "diagnosed" ||
      (task.status === "ready-for-implementation" && task.worktree === undefined)
    ) {
      task = (await this.worktrees.prepare(taskId)).task;
    }
    if (task.status !== "ready-for-implementation" || task.worktree === undefined) {
      throw new OrchestratorError(`Task ${taskId} cannot run from state ${task.status}`, {
        code: "TASK_STATE",
        nextCommand: `cxo task status ${taskId}`,
      });
    }

    const writerLock = await this.repositoryLock.acquireWriter(task.projectId);
    const callerSignal = overrides.abortSignal;
    const cancellation = new PersistedTaskCancellation(this.tasks, taskId, callerSignal);
    overrides = { ...overrides, abortSignal: cancellation.signal };
    let state = await this.tasks.getState(task.id);
    let primarySnapshot: { head: string; status: string } | undefined;
    let activeReservationId: string | undefined;
    try {
      task = await this.tasks.get(taskId);
      const project = await this.projects.inspect(task.projectId);
      const diagnosis = await this.diagnoses.read(project.id, task.id);
      assertTaskIntegrity(task, diagnosis);
      const baseCommit = task.worktree.baseCommit;
      const config = applyRunOverrides(await this.configService.load(), overrides, task.profile);
      const profile = overrides.profile ?? task.profile;
      const git = this.scopedGit(task);
      const manager = new WorktreeManager(this.paths, git);
      const worktree = await manager.inspect(project.gitRoot, task.worktree.path);
      if (
        worktree.branch !== task.worktree.branch ||
        task.worktree.baseCommit !== task.baseCommit ||
        !(await git.isAncestor(project.gitRoot, task.baseCommit, worktree.head))
      ) {
        throw new OrchestratorError("Task worktree branch identity changed", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const primaryHead = await git.resolveCommit(project.gitRoot, "HEAD");
      if (primaryHead !== diagnosis.sourceCommit) {
        throw new OrchestratorError("Primary source commit changed after diagnosis", {
          code: "CONTEXT_INTEGRITY",
          resumable: true,
        });
      }
      if (overrides.baseRef !== undefined) {
        const overrideCommit = await git.resolveCommit(project.gitRoot, overrides.baseRef);
        if (overrideCommit !== diagnosis.sourceCommit) {
          throw new OrchestratorError("The base-ref override does not match the diagnosis source", {
            code: "CONTEXT_INTEGRITY",
          });
        }
      }
      primarySnapshot = {
        head: primaryHead,
        status: await git.statusPorcelain(project.gitRoot),
      };
      await this.assertPrimaryUnchanged(git, project.gitRoot, primarySnapshot);
      const diffService = new DiffService(this.paths, git, undefined, undefined, this.clock);
      const verificationService = new VerificationService(
        config,
        this.paths,
        this.evidenceRepository,
        this.verificationRepository,
        diffService,
        this.clock,
      );
      const allAttempts = await this.executions.list(project.id, task.id);
      const existingAttempts = allAttempts.filter(
        (attempt) =>
          (attempt.phase === "implementation" || attempt.phase === "correction") &&
          !attempt.contextPackPath.includes("/review-correction-"),
      );
      const seenFailureSignatures = new Set(
        existingAttempts
          .map((attempt) => attempt.failureSignature)
          .filter((signature): signature is string => signature !== undefined),
      );
      const priorFailureAttempts = existingAttempts.filter(
        (attempt) => attempt.failureSignature !== undefined,
      );
      const maximumAttempts = config.profiles[profile].maxImplementationAttempts;
      if (priorFailureAttempts.length >= maximumAttempts) {
        await this.stopTask(task, state, "attempt_limit_reached");
      }
      const evidence = await this.evidenceRepository.read(project.id, task.id);
      const persistedOverrides = Object.fromEntries(
        Object.entries(overrides).filter(
          ([key, value]) => key !== "abortSignal" && value !== undefined,
        ),
      );
      if (Object.keys(persistedOverrides).length > 0) {
        await this.decisions.append(project.id, task.id, {
          kind: "human",
          summary: "Execution overrides applied to task run",
          details: persistedOverrides,
        });
      }
      let latestFailure: string | null = null;
      const interruptedReviewCorrection = allAttempts.some(
        (attempt) =>
          attempt.phase === "correction" &&
          attempt.contextPackPath.includes("/review-correction-") &&
          attempt.status !== "succeeded",
      );
      if (priorFailureAttempts.length > 0) {
        const priorVerification = await this.verificationRepository.read(project.id, task.id);
        if (
          priorVerification.taskId !== task.id ||
          priorVerification.sourceCommit !== diagnosis.sourceCommit ||
          priorVerification.overallStatus === "passed"
        ) {
          throw new OrchestratorError(
            "Resume is missing exact prior verification failure evidence",
            {
              code: "CONTEXT_INTEGRITY",
            },
          );
        }
        latestFailure = priorVerification.commands
          .filter((command) => command.status !== "passed")
          .map((command) => `${command.name}: ${command.excerpt}`)
          .join("\n")
          .slice(-config.context.maxExcerptCharacters);
      } else if (interruptedReviewCorrection) {
        const priorReview = await this.store.read(
          join(this.paths.taskDirectory(project.id, task.id), "review.json"),
          reviewResultSchema,
        );
        if (
          priorReview.taskId !== task.id ||
          priorReview.sourceCommit !== diagnosis.sourceCommit ||
          priorReview.verdict !== "changes-requested"
        ) {
          throw new OrchestratorError("Interrupted review correction has no compatible findings", {
            code: "CONTEXT_INTEGRITY",
          });
        }
        latestFailure = stableJson({
          reviewVerdict: priorReview.verdict,
          findings: priorReview.findings,
          acceptanceCriteriaAssessment: priorReview.acceptanceCriteriaAssessment.filter(
            (item) => item.status !== "met",
          ),
        }).slice(-config.context.maxExcerptCharacters);
      }
      let priorDecision: ModelDecision | undefined;
      let lastDiff: DiffArtifact | undefined;
      let lastVerification: VerificationResult | undefined;
      const runAttempts: ExecutionAttempt[] = [];

      ({ task, state } = await this.transition(
        task,
        state,
        "implementing",
        "Implementation started",
      ));
      for (
        let attemptOrdinal = priorFailureAttempts.length + 1;
        attemptOrdinal <= maximumAttempts;
        attemptOrdinal += 1
      ) {
        if (overrides.abortSignal?.aborted ?? false) {
          throw new OrchestratorError("Task run was cancelled", {
            code: "CANCELLED",
            resumable: false,
          });
        }
        await this.assertPrimaryUnchanged(git, project.gitRoot, primarySnapshot);
        const executionId = randomUUID();
        const attemptNumber =
          existingAttempts.length + (attemptOrdinal - priorFailureAttempts.length);
        const phase =
          attemptOrdinal === 1 && !interruptedReviewCorrection ? "implementation" : "correction";
        const worktreeHead = await git.resolveCommit(worktree.path, "HEAD");
        const selectedSkills = await this.skillRegistry.select({ phase, task, project });
        const contextPack = new ContextPackBuilder(config).build({
          phase,
          objective:
            phase === "implementation"
              ? `Implement ${task.title} in the isolated worktree`
              : `Correct ${task.title} using only the latest deterministic failure`,
          task,
          project,
          sourceCommit: diagnosis.sourceCommit,
          worktreeHead,
          diagnosis,
          evidence,
          relevantFiles: [
            ...diagnosis.affectedFiles.map((file) => file.path),
            ...diagnosis.implementationPlan.flatMap((step) => step.files),
          ],
          confirmedFacts: diagnosis.confirmedFacts.map((fact) => fact.statement),
          confirmedCauses: diagnosis.rootCauses.map((cause) => cause.statement),
          latestFailure,
          selectedSkills,
          outputSchema: toJsonSchema(implementationResultSchema),
        });
        await this.integrity.assertLiveInstructionFiles(contextPack, {
          task,
          project,
          sourceCommit: diagnosis.sourceCommit,
          worktreeHead,
          diagnosis,
        });
        const contextPackPath = join(
          this.paths.taskDirectory(project.id, task.id),
          "context-packs",
          `${phase}-${executionId}.json`,
        );
        await this.store.write(contextPackPath, contextPack);
        const ledger = await this.usage.read(project.id, task.id);
        const remainingBudget = Math.max(
          0,
          config.profiles[profile].maxTotalTokens - ledger.totals.totalTokens,
        );
        const estimatedCallTokens =
          contextPack.estimatedInputTokens + config.context.reservedOutputTokens;
        let routingOverrides: RoutingOverrides = {
          ...(overrides.model === undefined ? {} : { model: overrides.model }),
          ...(overrides.reasoning === undefined ? {} : { reasoning: overrides.reasoning }),
        };
        if (
          priorDecision !== undefined &&
          latestFailure !== null &&
          overrides.model === undefined &&
          overrides.reasoning === undefined
        ) {
          const escalation = new EscalationPolicy(config).evaluate({
            current: priorDecision,
            profile,
            failedOrUnresolved: true,
            hasNewEvidence: true,
            remainingBudgetTokens: remainingBudget,
            estimatedNextCallTokens: estimatedCallTokens,
          });
          await this.decisions.append(project.id, task.id, {
            kind: "escalation",
            summary: escalation.allowed ? "Implementation route escalated" : "Escalation declined",
            details: { ...escalation, attemptNumber },
          });
          if (escalation.allowed) {
            routingOverrides = { model: escalation.model, reasoning: escalation.reasoning };
          }
        }
        const modelDecision = new ModelRouter(config).route({
          phase,
          task,
          profile,
          estimatedCallTokens,
          remainingBudgetTokens: remainingBudget,
          priorFailedAttempts: attemptOrdinal - 1,
          overrides: routingOverrides,
        });
        priorDecision = modelDecision;
        const admission = await new ContextBudgetManager(config, this.usage).admitAndReserve({
          projectId: project.id,
          taskId: task.id,
          phase,
          profile,
          estimatedInputTokens: contextPack.estimatedInputTokens,
          activeParallelReaders: overrides.parallelReaders ?? 0,
          projectedAgentCalls: 2,
        });
        activeReservationId = admission.reservation.id;
        await this.decisions.append(project.id, task.id, {
          kind: "model-routing",
          summary: `${modelDecision.model} / ${modelDecision.reasoning} selected for ${phase}`,
          details: { ...modelDecision, attemptNumber },
        });
        if ((overrides.allowNetwork ?? false) && attemptNumber === existingAttempts.length + 1) {
          await this.decisions.append(project.id, task.id, {
            kind: "network-opt-in",
            summary: "Network access explicitly enabled for task run",
            details: { phase, executionId },
          });
        }
        const eventsPath = join(
          this.paths.taskDirectory(project.id, task.id),
          "logs",
          `${phase}-${executionId}.jsonl`,
        );
        let execution: ExecutionAttempt = {
          schemaVersion: 1,
          id: executionId,
          taskId: task.id,
          phase,
          attemptNumber,
          modelDecision,
          sandboxMode: "workspace-write",
          contextPackPath,
          inputEvidenceIds: evidence.map((item) => item.id),
          startedAt: isoNow(this.clock),
          status: "running",
          eventsPath,
        };
        await this.executions.save(project.id, execution);
        try {
          const prompt = await this.promptLoader.render(
            phase === "implementation" ? "implementation.prompt.md" : "correction.prompt.md",
            {
              TASK_ID: task.id,
              SOURCE_COMMIT: diagnosis.sourceCommit,
              DIAGNOSIS: stableJson(diagnosis),
              LATEST_FAILURE: latestFailure ?? "No prior deterministic failure",
              CONTEXT_PACK: stableJson(contextPack),
            },
          );
          const runtimeResult = await this.runtime.runStructured({
            role: phase === "implementation" ? "implementer" : "corrector",
            prompt,
            workingDirectory: worktree.path,
            model: modelDecision.model,
            reasoningPreset: modelDecision.reasoning,
            sandboxMode: "workspace-write",
            approvalPolicy: "never",
            networkAccessEnabled: overrides.allowNetwork ?? false,
            outputSchema: toJsonSchema(implementationResultSchema),
            outputValidator: implementationResultSchema,
            timeoutMs: overrides.timeoutMs ?? config.runtime.defaultTimeoutSeconds * 1_000,
            eventsPath,
            ...(overrides.abortSignal === undefined ? {} : { abortSignal: overrides.abortSignal }),
          });
          const implementation = implementationResultSchema.parse(runtimeResult.output);
          if (implementation.taskId !== task.id) {
            throw new OrchestratorError("Implementation result task identity mismatch", {
              code: "CONTEXT_INTEGRITY",
            });
          }
          const implementationPath = join(
            this.paths.taskDirectory(project.id, task.id),
            "runs",
            `${executionId}.implementation.json`,
          );
          await this.store.write(implementationPath, implementation);
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
          activeReservationId = undefined;
          const diff = await diffService.capture({
            projectId: project.id,
            taskId: task.id,
            worktreePath: worktree.path,
            sourceCommit: diagnosis.sourceCommit,
            baseCommit,
          });
          lastDiff = diff;
          await this.preserveAttemptPatch(diff, executionId);
          if (diff.changedFiles.length === 0) {
            execution = {
              ...execution,
              threadId: runtimeResult.threadId,
              completedAt: isoNow(this.clock),
              status: "blocked",
              usage: runtimeResult.usage,
              resultArtifactPath: implementationPath,
              error: {
                name: "OrchestratorError",
                message: "implementation_produced_no_diff",
                code: "VERIFICATION",
                resumable: true,
              },
            };
            await this.executions.save(project.id, execution);
            runAttempts.push(execution);
            await this.stopTask(task, state, "implementation_produced_no_diff");
          }
          ({ task, state } = await this.transition(
            task,
            state,
            "verifying",
            `Deterministic verification started for diff ${diff.diffHash}`,
            executionId,
          ));
          const verification = await verificationService.verify({
            task,
            project,
            worktreePath: worktree.path,
            diff,
            executionId,
            ...(overrides.abortSignal === undefined ? {} : { abortSignal: overrides.abortSignal }),
          });
          for (const item of verification.evidence) {
            if (!evidence.some((existing) => existing.id === item.id)) evidence.push(item);
          }
          lastVerification = verification.result;
          execution = {
            ...execution,
            threadId: runtimeResult.threadId,
            completedAt: isoNow(this.clock),
            status:
              verification.result.overallStatus === "passed"
                ? "succeeded"
                : verification.result.overallStatus === "failed"
                  ? "failed"
                  : "blocked",
            ...(verification.failureSignature === undefined
              ? {}
              : { failureSignature: verification.failureSignature }),
            usage: runtimeResult.usage,
            resultArtifactPath: implementationPath,
          };
          await this.executions.save(project.id, execution);
          runAttempts.push(execution);
          if (verification.result.overallStatus === "passed") {
            await this.assertPrimaryUnchanged(git, project.gitRoot, primarySnapshot);
            ({ task, state } = await this.transition(
              task,
              state,
              "reviewing",
              `Verification passed for diff ${diff.diffHash}`,
              executionId,
            ));
            return {
              task,
              diff,
              verification: verification.result,
              attempts: runAttempts,
              usage: await this.usage.read(project.id, task.id),
            };
          }
          if (verification.result.overallStatus === "blocked") {
            await this.stopTask(task, state, "verification_blocked");
          }
          const signature = verification.failureSignature;
          if (signature === undefined) {
            throw new OrchestratorError("Failed verification omitted a failure signature", {
              code: "CONTEXT_INTEGRITY",
            });
          }
          const repeated = seenFailureSignatures.has(signature);
          const decision = this.stopPolicy.evaluate({
            cancelled: false,
            budgetAvailable: true,
            sourceCommitChanged: false,
            repeatedFailureSignature: repeated,
            hasNewEvidence: !repeated,
            attempts: attemptOrdinal,
            maximumAttempts,
          });
          if (decision.stop) {
            await this.stopTask(task, state, decision.reason);
          }
          seenFailureSignatures.add(signature);
          latestFailure = verification.result.commands
            .filter((command) => command.status !== "passed")
            .map((command) => `${command.name}: ${command.excerpt}`)
            .join("\n")
            .slice(-config.context.maxExcerptCharacters);
          ({ task, state } = await this.transition(
            task,
            state,
            "implementing",
            "Retry admitted with new deterministic verification evidence",
            executionId,
          ));
        } catch (error) {
          if (activeReservationId !== undefined) {
            await this.usage
              .releaseReservation(project.id, task.id, activeReservationId)
              .catch(() => undefined);
            activeReservationId = undefined;
          }
          let normalized = toOrchestratorError(error);
          if (overrides.abortSignal?.aborted ?? false) {
            normalized = new OrchestratorError("Task run was cancelled", {
              code: "CANCELLED",
              resumable: true,
              cause: error,
            });
          }
          if (execution.status === "running") {
            execution = {
              ...execution,
              completedAt: isoNow(this.clock),
              status: normalized.code === "CANCELLED" ? "cancelled" : "blocked",
              error: {
                name: normalized.name,
                message: normalized.message,
                code: normalized.code,
                resumable: normalized.resumable,
              },
            };
            await this.executions.save(project.id, execution);
          }
          throw normalized;
        }
      }
      if (lastDiff !== undefined && lastVerification !== undefined) {
        return {
          task,
          diff: lastDiff,
          verification: lastVerification,
          attempts: runAttempts,
          usage: await this.usage.read(project.id, task.id),
        };
      }
      throw new OrchestratorError("Implementation attempt limit reached", {
        code: "VERIFICATION",
        resumable: true,
      });
    } catch (error) {
      let normalized = toOrchestratorError(error);
      if (activeReservationId !== undefined) {
        await this.usage
          .releaseReservation(task.projectId, task.id, activeReservationId)
          .catch(() => undefined);
      }
      state = await this.tasks.getState(task.id);
      task = await this.tasks.get(task.id);
      if (state.status === "cancelled" && normalized.code !== "CANCELLED") {
        normalized = new OrchestratorError("Task run was cancelled", {
          code: "CANCELLED",
          resumable: true,
          cause: error,
        });
      }
      if (["implementing", "verifying", "ready-for-implementation"].includes(state.status)) {
        const nextState = normalized.code === "CANCELLED" ? "cancelled" : "blocked";
        ({ task, state } = await this.transition(task, state, nextState, normalized.message));
      }
      throw normalized;
    } finally {
      cancellation.dispose(callerSignal);
      await writerLock.release();
    }
  }

  private scopedGit(task: Task): GitClient {
    return new GitClient({
      observer: async (record) => this.gitLog.append(task.projectId, task.id, record),
    });
  }

  private async assertPrimaryUnchanged(
    git: GitClient,
    gitRoot: string,
    expected: { head: string; status: string },
  ): Promise<void> {
    if (
      (await git.resolveCommit(gitRoot, "HEAD")) !== expected.head ||
      (await git.statusPorcelain(gitRoot)) !== expected.status
    ) {
      throw new OrchestratorError("Primary checkout changed during task execution", {
        code: "CONTEXT_INTEGRITY",
        resumable: true,
      });
    }
  }

  private async transition(
    task: Task,
    state: Awaited<ReturnType<TaskFileRepository["getState"]>>,
    nextState: Task["status"],
    reason: string,
    executionId?: string,
  ): Promise<{
    task: Task;
    state: Awaited<ReturnType<TaskFileRepository["getState"]>>;
  }> {
    const timestamp = isoNow(this.clock);
    const next = this.stateMachine.transition(state, {
      nextState,
      timestamp,
      reason,
      actor: "system",
      ...(executionId === undefined ? {} : { executionId }),
    });
    const updated = {
      ...task,
      status: nextState,
      revision: task.revision + 1,
      updatedAt: timestamp,
    };
    await this.tasks.update(updated, next);
    return { task: updated, state: next };
  }

  private async stopTask(
    task: Task,
    state: Awaited<ReturnType<TaskFileRepository["getState"]>>,
    reason: string,
  ): Promise<never> {
    await this.transition(task, state, "blocked", reason);
    throw new OrchestratorError(`Implementation stopped: ${reason}`, {
      code: "VERIFICATION",
      resumable: true,
      nextCommand: `cxo task status ${task.id}`,
    });
  }

  private async preserveAttemptPatch(diff: DiffArtifact, executionId: string): Promise<void> {
    const patch = await readFile(diff.patchPath, "utf8");
    await this.textWriter.writeText(
      join(dirname(diff.patchPath), "runs", `${executionId}.diff.patch`),
      patch,
    );
  }
}

function assertTaskIntegrity(
  task: Task,
  diagnosis: Diagnosis,
): asserts task is Task & {
  baseCommit: string;
  worktree: NonNullable<Task["worktree"]>;
} {
  if (
    task.baseCommit === undefined ||
    task.worktree === undefined ||
    task.worktree.baseCommit !== task.baseCommit ||
    diagnosis.taskId !== task.id ||
    diagnosis.sourceCommit !== task.baseCommit
  ) {
    throw new OrchestratorError("Task, diagnosis, and worktree base commits are incompatible", {
      code: "CONTEXT_INTEGRITY",
    });
  }
}

function applyRunOverrides(
  config: AppConfig,
  overrides: TaskRunOverrides,
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
    throw new OrchestratorError("Unable to create implementation output schema", {
      code: "CONFIGURATION",
    });
  }
  return converted;
}
