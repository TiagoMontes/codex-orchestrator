import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type {
  AppConfig,
  ExecutionProfile,
  ReasoningPreset,
} from "../configuration/config-schema.js";
import type { ConfigService } from "../configuration/config-service.js";
import type { ProjectManager } from "../projects/project-service.js";
import type { Diagnosis } from "../../domain/diagnosis/diagnosis.js";
import type { Evidence } from "../../domain/evidence/evidence.js";
import type { DiffArtifact } from "../../domain/execution/diff-artifact.js";
import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";
import { implementationResultSchema } from "../../domain/execution/implementation-result.js";
import type { ModelDecision } from "../../domain/execution/model-decision.js";
import type { Project } from "../../domain/project/project.js";
import type { ReviewFinding, ReviewResult } from "../../domain/review/review.js";
import { reviewResultSchema } from "../../domain/review/review.js";
import type { TaskStateDocument } from "../../domain/task/task-state.js";
import type { Task } from "../../domain/task/task.js";
import type { UsageLedgerDocument } from "../../domain/usage/usage-ledger.js";
import type { NormalizedUsage } from "../../domain/usage/usage.js";
import type { VerificationResult } from "../../domain/verification/verification.js";
import type { CodexRuntime } from "../../infrastructure/codex/codex-runtime.js";
import { resolveSafePath } from "../../infrastructure/filesystem/path-safety.js";
import { DiffService } from "../../infrastructure/git/diff-service.js";
import { GitClient } from "../../infrastructure/git/git-client.js";
import { GitCommandLog } from "../../infrastructure/git/git-command-log.js";
import { RepositoryLock } from "../../infrastructure/git/repository-lock.js";
import { WorktreeManager } from "../../infrastructure/git/worktree-manager.js";
import { AtomicJsonStore } from "../../infrastructure/persistence/atomic-json-store.js";
import type { DecisionFileRepository } from "../../infrastructure/persistence/decision-file-repository.js";
import type { DiagnosisFileRepository } from "../../infrastructure/persistence/diagnosis-file-repository.js";
import type { EvidenceFileRepository } from "../../infrastructure/persistence/evidence-file-repository.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";
import type { ReviewFileRepository } from "../../infrastructure/persistence/review-file-repository.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import type { UsageFileRepository } from "../../infrastructure/persistence/usage-file-repository.js";
import type { VerificationFileRepository } from "../../infrastructure/persistence/verification-file-repository.js";
import { FileLockManager } from "../../infrastructure/persistence/file-lock.js";
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
import { VerificationService } from "./verification-service.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { PersistedTaskCancellation } from "./persisted-task-cancellation.js";

export type TaskReviewOverrides = {
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

export type TaskReviewReport = {
  task: Task;
  reviews: ReviewResult[];
  corrections: ExecutionAttempt[];
  diff: DiffArtifact;
  verification: VerificationResult;
  usage: UsageLedgerDocument;
};

export interface TaskReviewer {
  review(taskId: string, overrides?: TaskReviewOverrides): Promise<TaskReviewReport>;
}

type AgentCallSetup = {
  config: AppConfig;
  profile: ExecutionProfile;
  task: Task;
  project: Project;
  phase: "review" | "correction";
  contextPackPath: string;
  estimatedInputTokens: number;
  attemptNumber: number;
  overrides: TaskReviewOverrides;
};

export class TaskReviewService implements TaskReviewer {
  private readonly stateMachine = new TaskStateMachine();
  private readonly promptLoader = new PromptLoader();
  private readonly integrity = new ContextIntegrityValidator();
  private readonly store = new AtomicJsonStore();
  private readonly skillRegistry = new SkillRegistry();
  private readonly repositoryLock: RepositoryLock;
  private readonly operationLocks: FileLockManager;
  private readonly gitLog: GitCommandLog;

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
    private readonly verificationRepository: VerificationFileRepository,
    private readonly reviews: ReviewFileRepository,
    private readonly clock: Clock = systemClock,
  ) {
    this.repositoryLock = new RepositoryLock(paths);
    this.operationLocks = new FileLockManager(paths.locksDirectory);
    this.gitLog = new GitCommandLog(paths);
  }

  async review(taskId: string, overrides: TaskReviewOverrides = {}): Promise<TaskReviewReport> {
    const operationLock = await this.operationLocks.acquire(`task-operation:${taskId}`);
    try {
      return await this.reviewLocked(taskId, overrides);
    } finally {
      await operationLock.release();
    }
  }

  private async reviewLocked(
    taskId: string,
    overrides: TaskReviewOverrides,
  ): Promise<TaskReviewReport> {
    let task = await this.tasks.get(taskId);
    let state = await this.tasks.getState(taskId);
    if (
      state.status !== "reviewing" ||
      task.worktree === undefined ||
      task.baseCommit === undefined
    ) {
      throw new OrchestratorError(`Task ${taskId} cannot be reviewed from state ${state.status}`, {
        code: "TASK_STATE",
        nextCommand: `cxo task status ${taskId}`,
      });
    }
    const lock = await this.repositoryLock.acquireWriter(task.projectId);
    const callerSignal = overrides.abortSignal;
    const cancellation = new PersistedTaskCancellation(this.tasks, taskId, callerSignal);
    overrides = { ...overrides, abortSignal: cancellation.signal };
    try {
      const project = await this.projects.inspect(task.projectId);
      const diagnosis = await this.diagnoses.read(project.id, task.id);
      assertReviewInputs(task, diagnosis);
      const config = applyReviewOverrides(await this.configService.load(), overrides, task.profile);
      const profile = overrides.profile ?? task.profile;
      const git = this.scopedGit(task);
      const worktree = await new WorktreeManager(this.paths, git).inspect(
        project.gitRoot,
        task.worktree.path,
      );
      if (worktree.branch !== task.worktree.branch) {
        throw new OrchestratorError("Review worktree branch identity changed", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const primary = {
        head: await git.resolveCommit(project.gitRoot, "HEAD"),
        status: await git.statusPorcelain(project.gitRoot),
      };
      if (primary.head !== diagnosis.sourceCommit) {
        throw new OrchestratorError("Primary source commit changed before review", {
          code: "CONTEXT_INTEGRITY",
          resumable: true,
        });
      }
      if (overrides.baseRef !== undefined) {
        const overrideCommit = await git.resolveCommit(project.gitRoot, overrides.baseRef);
        if (overrideCommit !== diagnosis.sourceCommit) {
          throw new OrchestratorError("Review base-ref override does not match the diagnosis", {
            code: "CONTEXT_INTEGRITY",
          });
        }
      }
      const diffService = new DiffService(this.paths, git, undefined, undefined, this.clock);
      let diff = await diffService.read(project.id, task.id);
      let verification = await this.verificationRepository.read(project.id, task.id);
      await assertReviewArtifacts(diffService, diff, verification, worktree.path, diagnosis);
      let patch = await readFile(diff.patchPath, "utf8");
      if (sha256(patch) !== diff.diffHash) {
        throw new OrchestratorError("Persisted review patch hash is invalid", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const evidence = await this.evidenceRepository.read(project.id, task.id);
      const reviewResults: ReviewResult[] = [];
      const corrections: ExecutionAttempt[] = [];
      const maximumCycles = config.profiles[profile].maxReviewCycles;
      const priorReviewCycles = (await this.executions.list(project.id, task.id)).filter(
        (attempt) => attempt.phase === "review",
      ).length;
      if (priorReviewCycles >= maximumCycles) {
        return this.stopTask(task, state, "review_cycle_limit_reached");
      }
      const persistedOverrides = Object.fromEntries(
        Object.entries(overrides).filter(
          ([key, value]) => key !== "abortSignal" && value !== undefined,
        ),
      );
      if (Object.keys(persistedOverrides).length > 0) {
        await this.decisions.append(project.id, task.id, {
          kind: "human",
          summary: "Execution overrides applied to independent review",
          details: persistedOverrides,
        });
      }

      for (let cycle = priorReviewCycles + 1; cycle <= maximumCycles; cycle += 1) {
        if (overrides.abortSignal?.aborted ?? false) {
          throw new OrchestratorError("Task review was cancelled", { code: "CANCELLED" });
        }
        await this.assertPrimaryUnchanged(git, project.gitRoot, primary);
        const reviewer = await this.runReviewer({
          config,
          profile,
          task,
          project,
          diagnosis,
          worktreePath: worktree.path,
          diff,
          patch,
          verification,
          evidence,
          cycle,
          overrides,
        });
        await diffService.assertCurrent(diff, worktree.path);
        let validated: Awaited<ReturnType<TaskReviewService["validateReview"]>>;
        try {
          validated = await this.validateReview(
            reviewer.review,
            task,
            diff,
            evidence,
            worktree.path,
            cycle,
          );
        } catch (error) {
          const normalized = toOrchestratorError(error);
          await this.executions.save(project.id, {
            ...reviewer.execution,
            threadId: reviewer.threadId,
            completedAt: isoNow(this.clock),
            status: "blocked",
            usage: reviewer.usage,
            error: {
              name: normalized.name,
              message: normalized.message,
              code: normalized.code,
              resumable: normalized.resumable,
            },
          });
          throw normalized;
        }
        await this.evidenceRepository.merge(project.id, task.id, validated.generatedEvidence);
        for (const item of validated.generatedEvidence) {
          if (!evidence.some((existing) => existing.id === item.id)) evidence.push(item);
        }
        const reviewPath = await this.reviews.save(
          project.id,
          validated.review,
          reviewer.execution.id,
        );
        const completedExecution: ExecutionAttempt = {
          ...reviewer.execution,
          completedAt: isoNow(this.clock),
          status: "succeeded",
          resultArtifactPath: reviewPath,
          threadId: reviewer.threadId,
          usage: reviewer.usage,
        };
        await this.executions.save(project.id, completedExecution);
        reviewResults.push(validated.review);

        const completionIssues = completionPolicyIssues(validated.review, task, verification);
        if (validated.review.verdict === "blocked") {
          await this.stopTask(task, state, "reviewer_blocked");
        }
        if (validated.review.verdict === "approve" && completionIssues.length === 0) {
          await diffService.assertCurrent(diff, worktree.path);
          await this.assertPrimaryUnchanged(git, project.gitRoot, primary);
          ({ task, state } = await this.transition(
            task,
            state,
            "completed",
            `Independent review approved diff ${diff.diffHash}`,
            reviewer.execution.id,
          ));
          return {
            task,
            reviews: reviewResults,
            corrections,
            diff,
            verification,
            usage: await this.usage.read(project.id, task.id),
          };
        }
        if (cycle >= maximumCycles) {
          await this.stopTask(task, state, "review_cycle_limit_reached");
        }

        ({ task, state } = await this.transition(
          task,
          state,
          "correcting",
          `Review cycle ${cycle} requested focused changes: ${completionIssues.join("; ") || "reviewer verdict"}`,
          reviewer.execution.id,
        ));
        const correction = await this.runCorrection({
          config,
          profile,
          task,
          project,
          diagnosis,
          worktreePath: worktree.path,
          diff,
          review: validated.review,
          evidence,
          cycle,
          overrides,
          diffService,
        });
        if (correction.diff.diffHash === diff.diffHash) {
          await this.executions.save(project.id, {
            ...correction.execution,
            completedAt: isoNow(this.clock),
            status: "blocked",
            threadId: correction.threadId,
            usage: correction.usage,
            error: {
              name: "OrchestratorError",
              message: "review_correction_produced_no_new_diff",
              code: "REVIEW_CHANGES",
              resumable: true,
            },
          });
          await this.stopTask(task, state, "review_correction_produced_no_new_diff");
        }
        ({ task, state } = await this.transition(
          task,
          state,
          "verifying",
          `Review correction produced diff ${correction.diff.diffHash}`,
          correction.execution.id,
        ));
        const verificationService = new VerificationService(
          config,
          this.paths,
          this.evidenceRepository,
          this.verificationRepository,
          diffService,
          this.clock,
        );
        const verificationReport = await verificationService.verify({
          task,
          project,
          worktreePath: worktree.path,
          diff: correction.diff,
          executionId: correction.execution.id,
          ...(overrides.abortSignal === undefined ? {} : { abortSignal: overrides.abortSignal }),
        });
        for (const item of verificationReport.evidence) {
          if (!evidence.some((existing) => existing.id === item.id)) evidence.push(item);
        }
        const correctionExecution: ExecutionAttempt = {
          ...correction.execution,
          completedAt: isoNow(this.clock),
          status: verificationReport.result.overallStatus === "passed" ? "succeeded" : "failed",
          threadId: correction.threadId,
          usage: correction.usage,
          resultArtifactPath: correction.resultArtifactPath,
          ...(verificationReport.failureSignature === undefined
            ? {}
            : { failureSignature: verificationReport.failureSignature }),
        };
        await this.executions.save(project.id, correctionExecution);
        corrections.push(correctionExecution);
        if (verificationReport.result.overallStatus !== "passed") {
          await this.stopTask(task, state, "review_correction_verification_failed");
        }
        diff = correction.diff;
        verification = verificationReport.result;
        patch = await readFile(diff.patchPath, "utf8");
        ({ task, state } = await this.transition(
          task,
          state,
          "reviewing",
          `Fresh review required for corrected diff ${diff.diffHash}`,
          correction.execution.id,
        ));
      }
      return this.stopTask(task, state, "review_cycle_limit_reached");
    } catch (error) {
      let normalized = toOrchestratorError(error);
      task = await this.tasks.get(task.id);
      state = await this.tasks.getState(task.id);
      if (state.status === "cancelled" && normalized.code !== "CANCELLED") {
        normalized = new OrchestratorError("Task review was cancelled", {
          code: "CANCELLED",
          resumable: true,
          cause: error,
        });
      }
      if (["reviewing", "correcting", "verifying"].includes(state.status)) {
        ({ task, state } = await this.transition(
          task,
          state,
          normalized.code === "CANCELLED" ? "cancelled" : "blocked",
          normalized.message,
        ));
      }
      throw normalized;
    } finally {
      cancellation.dispose(callerSignal);
      await lock.release();
    }
  }

  private async runReviewer(input: {
    config: AppConfig;
    profile: ExecutionProfile;
    task: Task;
    project: Project;
    diagnosis: Diagnosis;
    worktreePath: string;
    diff: DiffArtifact;
    patch: string;
    verification: VerificationResult;
    evidence: Evidence[];
    cycle: number;
    overrides: TaskReviewOverrides;
  }): Promise<{
    review: ReviewResult;
    execution: ExecutionAttempt;
    threadId: string;
    usage: NormalizedUsage;
  }> {
    const executionId = randomUUID();
    const worktreeHead = await this.scopedGit(input.task).resolveCommit(input.worktreePath, "HEAD");
    const selectedSkills = await this.skillRegistry.select({
      phase: "review",
      task: input.task,
      project: input.project,
    });
    const pack = new ContextPackBuilder(input.config).build({
      phase: "review",
      objective: `Independently review the exact diff for ${input.task.title}`,
      task: input.task,
      project: input.project,
      sourceCommit: input.diagnosis.sourceCommit,
      worktreeHead,
      diagnosis: input.diagnosis,
      verification: input.verification,
      diffHash: input.diff.diffHash,
      diffPatch: input.patch,
      evidence: input.evidence,
      relevantFiles: input.diff.changedFiles,
      confirmedFacts: input.diagnosis.confirmedFacts.map((fact) => fact.statement),
      confirmedCauses: input.diagnosis.rootCauses.map((cause) => cause.statement),
      selectedSkills,
      outputSchema: toJsonSchema(reviewResultSchema),
    });
    await this.integrity.assertLiveInstructionFiles(pack, {
      task: input.task,
      project: input.project,
      sourceCommit: input.diagnosis.sourceCommit,
      worktreeHead,
      diagnosis: input.diagnosis,
      verification: input.verification,
      diffHash: input.diff.diffHash,
    });
    const contextPackPath = join(
      this.paths.taskDirectory(input.project.id, input.task.id),
      "context-packs",
      `review-${executionId}.json`,
    );
    await this.store.write(contextPackPath, pack);
    const setup = await this.prepareAgentCall({
      config: input.config,
      profile: input.profile,
      task: input.task,
      project: input.project,
      phase: "review",
      contextPackPath,
      estimatedInputTokens: pack.estimatedInputTokens,
      attemptNumber: input.cycle,
      overrides: input.overrides,
    });
    const eventsPath = join(
      this.paths.taskDirectory(input.project.id, input.task.id),
      "logs",
      `review-${executionId}.jsonl`,
    );
    let execution: ExecutionAttempt = {
      schemaVersion: 1,
      id: executionId,
      taskId: input.task.id,
      phase: "review",
      attemptNumber: input.cycle,
      modelDecision: setup.modelDecision,
      sandboxMode: "read-only",
      contextPackPath,
      inputEvidenceIds: input.evidence.map((item) => item.id),
      startedAt: isoNow(this.clock),
      status: "running",
      eventsPath,
    };
    await this.executions.save(input.project.id, execution);
    try {
      const prompt = await this.promptLoader.render("review.prompt.md", {
        TASK_ID: input.task.id,
        SOURCE_COMMIT: input.diagnosis.sourceCommit,
        DIFF_HASH: input.diff.diffHash,
        CONTEXT_PACK: stableJson(pack),
      });
      const result = await this.runtime.runStructured({
        role: "reviewer",
        prompt,
        workingDirectory: input.worktreePath,
        model: setup.modelDecision.model,
        reasoningPreset: setup.modelDecision.reasoning,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: input.overrides.allowNetwork ?? false,
        outputSchema: toJsonSchema(reviewResultSchema),
        outputValidator: reviewResultSchema,
        timeoutMs: input.overrides.timeoutMs ?? input.config.runtime.defaultTimeoutSeconds * 1_000,
        eventsPath,
        ...(input.overrides.abortSignal === undefined
          ? {}
          : { abortSignal: input.overrides.abortSignal }),
      });
      await this.usage.commitReservation({
        projectId: input.project.id,
        taskId: input.task.id,
        reservationId: setup.reservationId,
        model: setup.modelDecision.model,
        reasoning: setup.modelDecision.reasoning,
        usage: result.usage,
        agentCalls: result.runtimeAttempts,
        threadId: result.threadId,
      });
      return {
        review: reviewResultSchema.parse(result.output),
        execution,
        threadId: result.threadId,
        usage: result.usage,
      };
    } catch (error) {
      await this.usage
        .releaseReservation(input.project.id, input.task.id, setup.reservationId)
        .catch(() => undefined);
      let normalized = toOrchestratorError(error);
      if (input.overrides.abortSignal?.aborted ?? false) {
        normalized = new OrchestratorError("Task review was cancelled", {
          code: "CANCELLED",
          resumable: true,
          cause: error,
        });
      }
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
      await this.executions.save(input.project.id, execution);
      throw normalized;
    }
  }

  private async runCorrection(input: {
    config: AppConfig;
    profile: ExecutionProfile;
    task: Task;
    project: Project;
    diagnosis: Diagnosis;
    worktreePath: string;
    diff: DiffArtifact;
    review: ReviewResult;
    evidence: Evidence[];
    cycle: number;
    overrides: TaskReviewOverrides;
    diffService: DiffService;
  }): Promise<{
    execution: ExecutionAttempt;
    threadId: string;
    usage: NormalizedUsage;
    diff: DiffArtifact;
    resultArtifactPath: string;
  }> {
    const executionId = randomUUID();
    const worktreeHead = await this.scopedGit(input.task).resolveCommit(input.worktreePath, "HEAD");
    const focusedReview = {
      verdict: input.review.verdict,
      findings: input.review.findings.slice(0, input.config.context.maxReviewFindings),
      acceptanceCriteriaAssessment: input.review.acceptanceCriteriaAssessment.filter(
        (item) => item.status !== "met",
      ),
      scopeAssessment: input.review.scopeAssessment,
    };
    const selectedSkills = await this.skillRegistry.select({
      phase: "correction",
      task: input.task,
      project: input.project,
    });
    const pack = new ContextPackBuilder(input.config).build({
      phase: "correction",
      objective: `Correct focused independent-review findings for ${input.task.title}`,
      task: input.task,
      project: input.project,
      sourceCommit: input.diagnosis.sourceCommit,
      worktreeHead,
      diagnosis: input.diagnosis,
      diffHash: input.diff.diffHash,
      evidence: input.evidence,
      relevantFiles: [
        ...input.review.findings.flatMap((finding) =>
          finding.file === undefined ? [] : [finding.file],
        ),
        ...input.diff.changedFiles,
      ],
      confirmedFacts: input.diagnosis.confirmedFacts.map((fact) => fact.statement),
      confirmedCauses: input.diagnosis.rootCauses.map((cause) => cause.statement),
      latestFailure: stableJson(focusedReview),
      selectedSkills,
      outputSchema: toJsonSchema(implementationResultSchema),
    });
    await this.integrity.assertLiveInstructionFiles(pack, {
      task: input.task,
      project: input.project,
      sourceCommit: input.diagnosis.sourceCommit,
      worktreeHead,
      diagnosis: input.diagnosis,
      diffHash: input.diff.diffHash,
    });
    const contextPackPath = join(
      this.paths.taskDirectory(input.project.id, input.task.id),
      "context-packs",
      `review-correction-${executionId}.json`,
    );
    await this.store.write(contextPackPath, pack);
    const setup = await this.prepareAgentCall({
      config: input.config,
      profile: input.profile,
      task: input.task,
      project: input.project,
      phase: "correction",
      contextPackPath,
      estimatedInputTokens: pack.estimatedInputTokens,
      attemptNumber: input.cycle,
      overrides: input.overrides,
    });
    const eventsPath = join(
      this.paths.taskDirectory(input.project.id, input.task.id),
      "logs",
      `review-correction-${executionId}.jsonl`,
    );
    let execution: ExecutionAttempt = {
      schemaVersion: 1,
      id: executionId,
      taskId: input.task.id,
      phase: "correction",
      attemptNumber: input.cycle,
      modelDecision: setup.modelDecision,
      sandboxMode: "workspace-write",
      contextPackPath,
      inputEvidenceIds: input.evidence.map((item) => item.id),
      startedAt: isoNow(this.clock),
      status: "running",
      eventsPath,
    };
    await this.executions.save(input.project.id, execution);
    try {
      const prompt = await this.promptLoader.render("review-correction.prompt.md", {
        TASK_ID: input.task.id,
        SOURCE_COMMIT: input.diagnosis.sourceCommit,
        DIFF_HASH: input.diff.diffHash,
        CONTEXT_PACK: stableJson(pack),
      });
      const result = await this.runtime.runStructured({
        role: "corrector",
        prompt,
        workingDirectory: input.worktreePath,
        model: setup.modelDecision.model,
        reasoningPreset: setup.modelDecision.reasoning,
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        networkAccessEnabled: input.overrides.allowNetwork ?? false,
        outputSchema: toJsonSchema(implementationResultSchema),
        outputValidator: implementationResultSchema,
        timeoutMs: input.overrides.timeoutMs ?? input.config.runtime.defaultTimeoutSeconds * 1_000,
        eventsPath,
        ...(input.overrides.abortSignal === undefined
          ? {}
          : { abortSignal: input.overrides.abortSignal }),
      });
      const implementation = implementationResultSchema.parse(result.output);
      if (implementation.taskId !== input.task.id) {
        throw new OrchestratorError("Review correction task identity mismatch", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const resultArtifactPath = join(
        this.paths.taskDirectory(input.project.id, input.task.id),
        "runs",
        `${executionId}.review-correction.json`,
      );
      await this.store.write(resultArtifactPath, implementation);
      await this.usage.commitReservation({
        projectId: input.project.id,
        taskId: input.task.id,
        reservationId: setup.reservationId,
        model: setup.modelDecision.model,
        reasoning: setup.modelDecision.reasoning,
        usage: result.usage,
        agentCalls: result.runtimeAttempts,
        threadId: result.threadId,
      });
      const diff = await input.diffService.capture({
        projectId: input.project.id,
        taskId: input.task.id,
        worktreePath: input.worktreePath,
        sourceCommit: input.diagnosis.sourceCommit,
        baseCommit: input.diff.baseCommit,
      });
      return {
        execution,
        threadId: result.threadId,
        usage: result.usage,
        diff,
        resultArtifactPath,
      };
    } catch (error) {
      await this.usage
        .releaseReservation(input.project.id, input.task.id, setup.reservationId)
        .catch(() => undefined);
      let normalized = toOrchestratorError(error);
      if (input.overrides.abortSignal?.aborted ?? false) {
        normalized = new OrchestratorError("Task review correction was cancelled", {
          code: "CANCELLED",
          resumable: true,
          cause: error,
        });
      }
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
      await this.executions.save(input.project.id, execution);
      throw normalized;
    }
  }

  private async prepareAgentCall(input: AgentCallSetup): Promise<{
    modelDecision: ModelDecision;
    reservationId: string;
  }> {
    const ledger = await this.usage.read(input.project.id, input.task.id);
    const remainingBudget = Math.max(
      0,
      input.config.profiles[input.profile].maxTotalTokens - ledger.totals.totalTokens,
    );
    const estimatedCallTokens =
      input.estimatedInputTokens + input.config.context.reservedOutputTokens;
    const routingOverrides: RoutingOverrides = {
      ...(input.overrides.model === undefined ? {} : { model: input.overrides.model }),
      ...(input.overrides.reasoning === undefined ? {} : { reasoning: input.overrides.reasoning }),
    };
    const modelDecision = new ModelRouter(input.config).route({
      phase: input.phase,
      task: input.task,
      profile: input.profile,
      estimatedCallTokens,
      remainingBudgetTokens: remainingBudget,
      priorFailedAttempts: input.attemptNumber - 1,
      overrides: routingOverrides,
    });
    const admission = await new ContextBudgetManager(input.config, this.usage).admitAndReserve({
      projectId: input.project.id,
      taskId: input.task.id,
      phase: input.phase,
      profile: input.profile,
      estimatedInputTokens: input.estimatedInputTokens,
      activeParallelReaders: input.overrides.parallelReaders ?? 0,
      projectedAgentCalls: 2,
    });
    await this.decisions.append(input.project.id, input.task.id, {
      kind: "model-routing",
      summary: `${modelDecision.model} / ${modelDecision.reasoning} selected for ${input.phase}`,
      details: { ...modelDecision, attemptNumber: input.attemptNumber },
    });
    if ((input.overrides.allowNetwork ?? false) && input.attemptNumber === 1) {
      await this.decisions.append(input.project.id, input.task.id, {
        kind: "network-opt-in",
        summary: `Network access explicitly enabled for ${input.phase}`,
        details: { phase: input.phase },
      });
    }
    return { modelDecision, reservationId: admission.reservation.id };
  }

  private async validateReview(
    input: ReviewResult,
    task: Task,
    diff: DiffArtifact,
    evidence: readonly Evidence[],
    worktreePath: string,
    cycle: number,
  ): Promise<{ review: ReviewResult; generatedEvidence: Evidence[] }> {
    if (
      input.taskId !== task.id ||
      input.sourceCommit !== diff.sourceCommit ||
      input.reviewedDiffHash !== diff.diffHash
    ) {
      throw new OrchestratorError("Reviewer result identity or diff hash mismatch", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const expectedCriteria = new Set(task.acceptanceCriteria.map((criterion) => criterion.id));
    const actualCriteria = new Set(
      input.acceptanceCriteriaAssessment.map((assessment) => assessment.criterionId),
    );
    if (
      expectedCriteria.size !== actualCriteria.size ||
      [...expectedCriteria].some((id) => !actualCriteria.has(id))
    ) {
      throw new OrchestratorError(
        "Reviewer did not assess every acceptance criterion exactly once",
        {
          code: "CONTEXT_INTEGRITY",
        },
      );
    }
    const availableEvidence = new Set(evidence.map((item) => item.id));
    const generatedEvidence: Evidence[] = [];
    const findings: ReviewFinding[] = [];
    for (const finding of input.findings) {
      const missing = finding.evidenceIds.filter((id) => !availableEvidence.has(id));
      if (missing.length > 0) {
        throw new OrchestratorError(
          `Review finding references missing evidence: ${missing.join(", ")}`,
          {
            code: "CONTEXT_INTEGRITY",
          },
        );
      }
      if (finding.file === undefined) {
        if (finding.evidenceIds.length === 0) {
          throw new OrchestratorError(`Review finding ${finding.id} has no evidence`, {
            code: "CONTEXT_INTEGRITY",
          });
        }
        findings.push(finding);
        continue;
      }
      if (!diff.changedFiles.includes(finding.file)) {
        throw new OrchestratorError(
          `Review finding is outside the captured diff: ${finding.file}`,
          {
            code: "CONTEXT_INTEGRITY",
          },
        );
      }
      const path = await resolveSafePath(worktreePath, finding.file);
      const contents = await readFile(path);
      const lines = contents.toString("utf8").split(/\r?\n/u);
      const startLine = finding.startLine ?? 1;
      const endLine = finding.endLine ?? Math.min(lines.length, startLine + 19);
      if (startLine > lines.length || endLine > lines.length) {
        throw new OrchestratorError(`Review finding line range is outside ${finding.file}`, {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const evidenceId = `REV-${cycle}-${finding.id}-${sha256(`${diff.diffHash}:${finding.id}`).slice(0, 10)}`;
      generatedEvidence.push({
        id: evidenceId,
        taskId: task.id,
        kind: "review",
        status: "confirmed",
        statement: finding.explanation,
        sourceCommit: diff.sourceCommit,
        file: relative(worktreePath, path),
        startLine,
        endLine,
        excerpt: lines
          .slice(startLine - 1, endLine)
          .join("\n")
          .slice(0, 4_000),
        sha256: sha256(contents),
        observedAt: isoNow(this.clock),
      });
      availableEvidence.add(evidenceId);
      findings.push({
        ...finding,
        file: relative(worktreePath, path),
        startLine,
        endLine,
        evidenceIds: [...new Set([...finding.evidenceIds, evidenceId])],
      });
    }
    for (const assessment of input.acceptanceCriteriaAssessment) {
      const missing = assessment.evidenceIds.filter((id) => !availableEvidence.has(id));
      if (missing.length > 0) {
        throw new OrchestratorError(
          `Acceptance assessment references missing evidence: ${missing.join(", ")}`,
          { code: "CONTEXT_INTEGRITY" },
        );
      }
    }
    if (input.scopeAssessment.unexpectedFiles.some((path) => !diff.changedFiles.includes(path))) {
      throw new OrchestratorError("Scope assessment references files outside the captured diff", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    return {
      review: reviewResultSchema.parse({ ...input, findings }),
      generatedEvidence,
    };
  }

  private async transition(
    task: Task,
    state: TaskStateDocument,
    nextState: Task["status"],
    reason: string,
    executionId?: string,
  ): Promise<{ task: Task; state: TaskStateDocument }> {
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

  private async stopTask(task: Task, state: TaskStateDocument, reason: string): Promise<never> {
    await this.transition(task, state, "blocked", reason);
    throw new OrchestratorError(`Review stopped: ${reason}`, {
      code: "REVIEW_CHANGES",
      resumable: true,
      nextCommand: `cxo task status ${task.id}`,
    });
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
      throw new OrchestratorError("Primary checkout changed during review", {
        code: "CONTEXT_INTEGRITY",
        resumable: true,
      });
    }
  }
}

function assertReviewInputs(
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
    throw new OrchestratorError("Review task, diagnosis, and worktree are incompatible", {
      code: "CONTEXT_INTEGRITY",
    });
  }
}

async function assertReviewArtifacts(
  diffService: DiffService,
  diff: DiffArtifact,
  verification: VerificationResult,
  worktreePath: string,
  diagnosis: Diagnosis,
): Promise<void> {
  await diffService.assertCurrent(diff, worktreePath);
  if (
    diff.sourceCommit !== diagnosis.sourceCommit ||
    verification.taskId !== diagnosis.taskId ||
    verification.sourceCommit !== diagnosis.sourceCommit ||
    verification.diffHash !== diff.diffHash ||
    verification.overallStatus !== "passed"
  ) {
    throw new OrchestratorError("Review requires passing verification for the exact current diff", {
      code: "CONTEXT_INTEGRITY",
      resumable: true,
    });
  }
}

function completionPolicyIssues(
  review: ReviewResult,
  task: Task,
  verification: VerificationResult,
): string[] {
  const issues: string[] = [];
  if (
    review.findings.some(
      (finding) => finding.severity === "critical" || finding.severity === "high",
    )
  ) {
    issues.push("critical-or-high-finding");
  }
  const assessment = new Map(
    review.acceptanceCriteriaAssessment.map((item) => [item.criterionId, item]),
  );
  if (
    task.acceptanceCriteria
      .filter((criterion) => criterion.required)
      .some((criterion) => assessment.get(criterion.id)?.status !== "met")
  ) {
    issues.push("required-criterion-not-met");
  }
  if (!review.scopeAssessment.withinScope) issues.push("diff-outside-scope");
  if (verification.overallStatus !== "passed") issues.push("verification-not-passed");
  if (review.verdict === "changes-requested") issues.push("reviewer-requested-changes");
  return issues;
}

function applyReviewOverrides(
  config: AppConfig,
  overrides: TaskReviewOverrides,
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
    throw new OrchestratorError("Unable to create structured review output schema", {
      code: "CONFIGURATION",
    });
  }
  return converted;
}
