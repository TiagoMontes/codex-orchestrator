import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type {
  AppConfig,
  ExecutionProfile,
  ReasoningPreset,
} from "../../application/configuration/config-schema.js";
import type { Project } from "../../domain/project/project.js";
import type { Task } from "../../domain/task/task.js";
import type { Evidence } from "../../domain/evidence/evidence.js";
import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";
import type { ModelDecision } from "../../domain/execution/model-decision.js";
import type { UsageLedgerDocument } from "../../domain/usage/usage-ledger.js";
import type {
  CodexProgressObserver,
  CodexRuntime,
} from "../../infrastructure/codex/codex-runtime.js";
import {
  canonicalizeExistingPath,
  resolveSafePath,
} from "../../infrastructure/filesystem/path-safety.js";
import { GitClient } from "../../infrastructure/git/git-client.js";
import { GitCommandLog } from "../../infrastructure/git/git-command-log.js";
import type { DecisionFileRepository } from "../../infrastructure/persistence/decision-file-repository.js";
import type { EvidenceFileRepository } from "../../infrastructure/persistence/evidence-file-repository.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import type { UsageFileRepository } from "../../infrastructure/persistence/usage-file-repository.js";
import { AtomicJsonStore } from "../../infrastructure/persistence/atomic-json-store.js";
import { PromptLoader } from "../../prompts/prompt-loader.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError, toOrchestratorError } from "../../shared/errors.js";
import { sha256, stableJson } from "../../shared/hashing.js";
import { ContextBudgetManager } from "../context/context-budget-manager.js";
import { ContextIntegrityValidator } from "../context/context-integrity-validator.js";
import { ContextPackBuilder } from "../context/context-pack-builder.js";
import { assertStructuredOutputBounded } from "../context/structured-output-bound.js";
import { ModelRouter, type RoutingOverrides } from "../routing/model-router.js";
import { SkillRegistry } from "../../application/skills/skill-registry.js";
import {
  consolidatedReadResultSchema,
  readWorkerResultSchema,
  type ConsolidatedReadResult,
  type ReadWorkerResult,
} from "./parallel-read-result.js";
import { assertIndependentWorkstreams, type ReadWorkstream } from "./workstream-partitioner.js";
import { semanticEvidenceId, semanticEvidenceInput } from "../context/evidence-fingerprint.js";
import { executionInputFingerprint } from "../../application/tasks/execution-input-fingerprint.js";
import { projectAtWorkingRoot } from "../../application/projects/project-working-copy.js";

export type ParallelReadOverrides = {
  model?: string;
  reasoning?: ReasoningPreset;
  maxParallelReaders?: number;
  timeoutMs?: number;
  progress?: CodexProgressObserver;
  abortSignal?: AbortSignal;
};

export type ParallelReadReport = {
  result: ConsolidatedReadResult;
  attempts: ExecutionAttempt[];
  usage: UsageLedgerDocument;
};

type PreparedWorker = {
  workstream: ReadWorkstream;
  modelDecision: ModelDecision;
  reservationId: string;
  execution: ExecutionAttempt;
  contextPack: ReturnType<ContextPackBuilder["build"]>;
  workerTokenCap: number;
};

type WorkerStartGate = {
  wait(): Promise<void>;
  abort(error: unknown): void;
};

export class ParallelReadCoordinator {
  private readonly store = new AtomicJsonStore();
  private readonly promptLoader = new PromptLoader();
  private readonly integrity = new ContextIntegrityValidator();
  private readonly skillRegistry = new SkillRegistry();
  private readonly gitLog: GitCommandLog;
  private usageMutation: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly paths: StatePaths,
    private readonly runtime: CodexRuntime,
    private readonly usage: UsageFileRepository,
    private readonly evidenceRepository: EvidenceFileRepository,
    private readonly executions: ExecutionFileRepository,
    private readonly decisions: DecisionFileRepository,
    private readonly clock: Clock = systemClock,
  ) {
    this.gitLog = new GitCommandLog(paths);
  }

  async run(input: {
    task: Task;
    project: Project;
    sourceCommit: string;
    profile: ExecutionProfile;
    workstreams: ReadWorkstream[];
    workingDirectory?: string;
    overrides?: ParallelReadOverrides;
  }): Promise<ParallelReadReport> {
    if (
      !this.config.parallelism.enabled ||
      !this.config.parallelism.readOnlyOnly ||
      this.config.parallelism.maxDepth !== 1 ||
      this.config.parallelism.allowNestedAgents ||
      !this.config.parallelism.oneWriterOnly ||
      !this.config.parallelism.sharedTaskBudget ||
      this.config.parallelism.nativeCodexSubagents
    ) {
      throw new OrchestratorError("Parallel read security policy is not satisfied", {
        code: "CONFIGURATION",
      });
    }
    if (input.workstreams.length < 2) {
      throw new OrchestratorError("Parallel coordination requires at least two workstreams", {
        code: "CONFIGURATION",
      });
    }
    const limits = this.config.profiles[input.profile];
    const readerLimit = Math.min(
      this.config.parallelism.maxParallelReaders,
      limits.maxParallelReaders,
      input.overrides?.maxParallelReaders ?? Number.POSITIVE_INFINITY,
    );
    if (input.workstreams.length > readerLimit) {
      throw new OrchestratorError("Parallel reader limit would be exceeded", {
        code: "BUDGET",
        resumable: true,
      });
    }
    assertIndependentWorkstreams(input.workstreams);
    const workingDirectory =
      input.workingDirectory === undefined
        ? input.project.gitRoot
        : await resolveSafePath(this.paths.worktreesDirectory, input.workingDirectory);
    const phaseProject = await projectAtWorkingRoot(
      input.project,
      workingDirectory,
      input.sourceCommit,
    );
    const git = new GitClient({
      observer: async (record) =>
        this.gitLog.append(input.project.id, input.task.id, record, { phase: "exploration" }),
    });
    const before = {
      head: await git.resolveCommit(workingDirectory, "HEAD"),
      status: await git.statusPorcelain(workingDirectory),
    };
    if (before.head !== input.sourceCommit) {
      throw new OrchestratorError("Parallel read source commit is stale", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const coordinatorId = randomUUID();
    const prepared: PreparedWorker[] = [];
    try {
      for (const [workerIndex, workstream] of input.workstreams.entries()) {
        prepared.push(
          await this.prepareWorker({
            ...input,
            project: phaseProject,
            workingDirectory,
            workstream,
            workerIndex,
            coordinatorId,
            readerCount: input.workstreams.length,
          }),
        );
      }
    } catch (error) {
      for (const worker of prepared) {
        await this.serializeUsageMutation(async () =>
          this.usage.releaseReservation(input.project.id, input.task.id, worker.reservationId),
        );
        await this.executions.save(input.project.id, {
          ...worker.execution,
          completedAt: isoNow(this.clock),
          status: "blocked",
          error: {
            name: "OrchestratorError",
            message: "Parallel worker admission was rolled back before execution",
            code: "BUDGET",
            resumable: true,
          },
        });
      }
      throw error;
    }

    const startGate = createWorkerStartGate(prepared.length);
    const settled = await Promise.allSettled(
      prepared.map(async (worker) =>
        this.runWorker({ ...input, project: phaseProject }, worker, startGate),
      ),
    );
    const attempts: ExecutionAttempt[] = [];
    const results: ReadWorkerResult[] = [];
    let firstError: unknown;
    for (const item of settled) {
      if (item.status === "fulfilled") {
        attempts.push(item.value.execution);
        results.push(item.value.result);
      } else if (firstError === undefined) {
        firstError = item.reason;
      }
    }
    if (firstError !== undefined) throw toOrchestratorError(firstError);
    if (
      (await git.resolveCommit(workingDirectory, "HEAD")) !== before.head ||
      (await git.statusPorcelain(workingDirectory)) !== before.status
    ) {
      throw new OrchestratorError("Repository changed during parallel read coordination", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const evidence = deduplicateEvidence(results.flatMap((result) => result.evidence));
    if (evidence.length > this.config.context.maxEvidenceItems) {
      throw new OrchestratorError("Parallel evidence exceeds the configured task bound", {
        code: "BUDGET",
        resumable: true,
      });
    }
    await this.evidenceRepository.merge(input.project.id, input.task.id, evidence);
    const consolidated = consolidatedReadResultSchema.parse({
      schemaVersion: 1,
      taskId: input.task.id,
      projectId: input.project.id,
      sourceCommit: input.sourceCommit,
      coordinatorId,
      workerIds: results.map((result) => result.workerId).sort(),
      summaries: results
        .map((result) => ({ workerId: result.workerId, summary: result.summary }))
        .sort((left, right) => left.workerId.localeCompare(right.workerId)),
      evidence,
      createdAt: isoNow(this.clock),
    });
    await this.store.write(
      join(
        this.paths.taskDirectory(input.project.id, input.task.id),
        "runs",
        `parallel-${coordinatorId}.json`,
      ),
      consolidated,
    );
    return {
      result: consolidated,
      attempts: attempts.sort((left, right) => left.attemptNumber - right.attemptNumber),
      usage: await this.usage.read(input.project.id, input.task.id),
    };
  }

  private async prepareWorker(input: {
    task: Task;
    project: Project;
    sourceCommit: string;
    workingDirectory: string;
    profile: ExecutionProfile;
    overrides?: ParallelReadOverrides;
    workstream: ReadWorkstream;
    workerIndex: number;
    coordinatorId: string;
    readerCount: number;
  }): Promise<PreparedWorker> {
    const executionId = randomUUID();
    const selectedSkills = await this.skillRegistry.select({
      phase: "exploration",
      task: input.task,
      project: input.project,
    });
    const pack = new ContextPackBuilder(this.config).build({
      phase: "exploration",
      objective: input.workstream.objective,
      task: input.task,
      project: input.project,
      sourceCommit: input.sourceCommit,
      evidence: [],
      relevantFiles: input.workstream.relevantFiles,
      selectedSkills,
      outputSchema: toJsonSchema(readWorkerResultSchema),
    });
    await this.integrity.assertLiveInstructionFiles(
      pack,
      {
        task: input.task,
        project: input.project,
        sourceCommit: input.sourceCommit,
      },
      input.workingDirectory,
    );
    const inputFingerprint = executionInputFingerprint({
      phase: "exploration",
      taskId: input.task.id,
      projectId: input.project.id,
      sourceCommit: input.sourceCommit,
      workstream: input.workstream,
      instructions: input.project.instructionFiles.map(({ relativePath, sha256 }) => ({
        relativePath,
        sha256,
      })),
      selectedSkills: selectedSkills.map(
        ({ name, source, sha256: skillSha256, instructionsSha256 }) => ({
          name,
          source,
          sha256: skillSha256,
          instructionsSha256,
        }),
      ),
    });
    const ledger = await this.usage.read(input.project.id, input.task.id);
    const remaining = Math.max(
      0,
      this.config.profiles[input.profile].maxTotalTokens - ledger.totals.totalTokens,
    );
    const workerTokenCap = Math.floor(remaining / input.readerCount);
    const projected = pack.estimatedInputTokens + this.config.context.reservedOutputTokens;
    const worstCaseProjected = projected * 2;
    if (worstCaseProjected > workerTokenCap) {
      throw new OrchestratorError(
        `Workstream ${input.workstream.id} exceeds its shared per-worker token cap`,
        { code: "BUDGET", resumable: true },
      );
    }
    const routingOverrides: RoutingOverrides = {
      ...(input.overrides?.model === undefined ? {} : { model: input.overrides.model }),
      ...(input.overrides?.reasoning === undefined ? {} : { reasoning: input.overrides.reasoning }),
    };
    const modelDecision = new ModelRouter(this.config).route({
      phase: "exploration",
      task: input.task,
      profile: input.profile,
      estimatedCallTokens: projected,
      remainingBudgetTokens: remaining,
      overrides: routingOverrides,
    });
    const admission = await new ContextBudgetManager(this.config, this.usage).admitAndReserve({
      projectId: input.project.id,
      taskId: input.task.id,
      phase: "exploration",
      profile: input.profile,
      estimatedInputTokens: pack.estimatedInputTokens,
      activeParallelReaders: input.readerCount,
      projectedAgentCalls: 2,
      workerId: input.workstream.id,
    });
    const contextPackPath = join(
      this.paths.taskDirectory(input.project.id, input.task.id),
      "context-packs",
      `read-${input.workstream.id}-${executionId}.json`,
    );
    const eventsPath = join(
      this.paths.taskDirectory(input.project.id, input.task.id),
      "logs",
      `read-${input.workstream.id}-${executionId}.jsonl`,
    );
    const execution: ExecutionAttempt = {
      schemaVersion: 1,
      id: executionId,
      taskId: input.task.id,
      phase: "exploration",
      attemptNumber: input.workerIndex + 1,
      reservationId: admission.reservation.id,
      inputFingerprint,
      modelDecision,
      sandboxMode: "read-only",
      contextPackPath,
      inputEvidenceIds: [],
      startedAt: isoNow(this.clock),
      status: "running",
      eventsPath,
    };
    let executionPersisted = false;
    try {
      await this.store.write(contextPackPath, pack);
      await this.executions.save(input.project.id, execution);
      executionPersisted = true;
      await this.decisions.append(input.project.id, input.task.id, {
        kind: "model-routing",
        summary: `${modelDecision.model} / ${modelDecision.reasoning} selected for read worker ${input.workstream.id}`,
        details: {
          ...modelDecision,
          workerId: input.workstream.id,
          coordinatorId: input.coordinatorId,
          workerTokenCap,
        },
      });
      return {
        workstream: input.workstream,
        modelDecision,
        reservationId: admission.reservation.id,
        execution,
        contextPack: pack,
        workerTokenCap,
      };
    } catch (error) {
      await this.serializeUsageMutation(async () =>
        this.usage.releaseReservation(input.project.id, input.task.id, admission.reservation.id),
      ).catch(() => undefined);
      if (executionPersisted) {
        const normalized = toOrchestratorError(error);
        await this.executions
          .save(input.project.id, {
            ...execution,
            completedAt: isoNow(this.clock),
            status: normalized.resumable ? "blocked" : "failed",
            error: {
              name: normalized.name,
              message: normalized.message,
              code: normalized.code,
              resumable: normalized.resumable,
            },
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  private async runWorker(
    parent: {
      task: Task;
      project: Project;
      sourceCommit: string;
      profile: ExecutionProfile;
      workstreams: ReadWorkstream[];
      workingDirectory?: string;
      overrides?: ParallelReadOverrides;
    },
    worker: PreparedWorker,
    startGate: WorkerStartGate,
  ): Promise<{ result: ReadWorkerResult; execution: ExecutionAttempt }> {
    let execution = worker.execution;
    let callStarted = false;
    try {
      const prompt = await this.promptLoader.render("read-worker.prompt.md", {
        WORKER_ID: worker.workstream.id,
        TASK_ID: parent.task.id,
        SOURCE_COMMIT: parent.sourceCommit,
        WORKER_TOKEN_CAP: String(worker.workerTokenCap),
        CONTEXT_PACK: stableJson(worker.contextPack),
      });
      await startGate.wait();
      execution = { ...execution, callStartedAt: isoNow(this.clock) };
      await this.executions.save(parent.project.id, execution);
      callStarted = true;
      const runtimeResult = await this.runtime.runStructured({
        role: "read-worker",
        prompt,
        workingDirectory: parent.workingDirectory ?? parent.project.gitRoot,
        model: worker.modelDecision.model,
        reasoningPreset: worker.modelDecision.reasoning,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        outputSchema: toJsonSchema(readWorkerResultSchema),
        outputValidator: readWorkerResultSchema,
        timeoutMs: parent.overrides?.timeoutMs ?? this.config.runtime.defaultTimeoutSeconds * 1_000,
        eventsPath: execution.eventsPath,
        additionalAllowedEnvironmentNames: parent.project.environmentPolicy.allowlist,
        explicitSecretEnvironmentExceptions: parent.project.environmentPolicy.secretExceptions,
        ...(parent.overrides?.progress === undefined
          ? {}
          : { progress: parent.overrides.progress }),
        ...(parent.overrides?.abortSignal === undefined
          ? {}
          : { abortSignal: parent.overrides.abortSignal }),
      });
      assertStructuredOutputBounded(runtimeResult.output, this.config);
      const output = readWorkerResultSchema.parse(runtimeResult.output);
      if (
        output.workerId !== worker.workstream.id ||
        output.taskId !== parent.task.id ||
        output.sourceCommit !== parent.sourceCommit
      ) {
        throw new OrchestratorError("Parallel read worker identity mismatch", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const workerEvidenceLimit = Math.max(
        1,
        Math.floor(this.config.context.maxEvidenceItems / parent.workstreams.length),
      );
      if (output.evidence.length > workerEvidenceLimit) {
        throw new OrchestratorError(
          `Read worker ${worker.workstream.id} exceeded its evidence allocation`,
          { code: "BUDGET", resumable: true },
        );
      }
      const evidence = await this.validateEvidence(output.evidence, worker.workstream, parent);
      const result = readWorkerResultSchema.parse({
        ...output,
        summary: output.summary.slice(0, this.config.context.maxExcerptCharacters),
        evidence,
      });
      const resultPath = join(
        this.paths.taskDirectory(parent.project.id, parent.task.id),
        "runs",
        `${execution.id}.worker.json`,
      );
      await this.store.write(resultPath, result);
      await this.serializeUsageMutation(async () =>
        this.usage.commitReservation({
          projectId: parent.project.id,
          taskId: parent.task.id,
          reservationId: worker.reservationId,
          model: worker.modelDecision.model,
          reasoning: worker.modelDecision.reasoning,
          usage: runtimeResult.usage,
          agentCalls: runtimeResult.runtimeAttempts,
          threadId: runtimeResult.threadId,
        }),
      );
      execution = {
        ...execution,
        threadId: runtimeResult.threadId,
        completedAt: isoNow(this.clock),
        status: "succeeded",
        usage: runtimeResult.usage,
        resultArtifactPath: resultPath,
      };
      await this.executions.save(parent.project.id, execution);
      return { result, execution };
    } catch (error) {
      startGate.abort(error);
      await this.serializeUsageMutation(async () => {
        if (!callStarted) {
          await this.usage.releaseReservation(
            parent.project.id,
            parent.task.id,
            worker.reservationId,
          );
          return;
        }
        await this.usage.commitFailedReservation({
          projectId: parent.project.id,
          taskId: parent.task.id,
          reservationId: worker.reservationId,
          model: worker.modelDecision.model,
          reasoning: worker.modelDecision.reasoning,
        });
      }).catch(() => undefined);
      const normalized = toOrchestratorError(error);
      execution = {
        ...execution,
        completedAt: isoNow(this.clock),
        status:
          normalized.code === "CANCELLED"
            ? "cancelled"
            : normalized.resumable
              ? "blocked"
              : "failed",
        error: {
          name: normalized.name,
          message: normalized.message,
          code: normalized.code,
          resumable: normalized.resumable,
        },
      };
      await this.executions.save(parent.project.id, execution);
      throw normalized;
    }
  }

  private async validateEvidence(
    items: readonly Evidence[],
    workstream: ReadWorkstream,
    parent: { task: Task; project: Project; sourceCommit: string; workingDirectory?: string },
  ): Promise<Evidence[]> {
    return Promise.all(
      items.map(async (item) => {
        if (item.taskId !== parent.task.id || item.sourceCommit !== parent.sourceCommit) {
          throw new OrchestratorError("Read worker evidence identity mismatch", {
            code: "CONTEXT_INTEGRITY",
          });
        }
        if (item.file === undefined) {
          const semantic = { ...item, id: "pending" };
          return { ...semantic, id: semanticEvidenceId("PW", semantic) };
        }
        const root = await canonicalizeExistingPath(
          parent.workingDirectory ?? parent.project.gitRoot,
        );
        const path = await resolveSafePath(root, item.file);
        const relativePath = relative(root, path).replaceAll("\\", "/");
        if (
          workstream.relevantFiles.length > 0 &&
          !workstream.relevantFiles.some((scope) => pathContains(scope, relativePath))
        ) {
          throw new OrchestratorError(
            `Read-worker evidence ${relativePath} is outside workstream ${workstream.id}`,
            { code: "CONTEXT_INTEGRITY" },
          );
        }
        const contents = await readFile(path);
        const lines = contents.toString("utf8").split(/\r?\n/u);
        const startLine = item.startLine ?? 1;
        const endLine = item.endLine ?? Math.min(lines.length, startLine + 19);
        if (startLine > lines.length || endLine > lines.length) {
          throw new OrchestratorError(`Read-worker evidence is outside ${item.file}`, {
            code: "CONTEXT_INTEGRITY",
          });
        }
        const semantic: Evidence = {
          ...item,
          id: "pending",
          file: relativePath,
          startLine,
          endLine,
          excerpt: lines
            .slice(startLine - 1, endLine)
            .join("\n")
            .slice(0, 4_000),
          sha256: sha256(contents),
        };
        return { ...semantic, id: semanticEvidenceId("PW", semantic) };
      }),
    );
  }

  private serializeUsageMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.usageMutation.then(operation, operation);
    this.usageMutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function createWorkerStartGate(participantCount: number): WorkerStartGate {
  let arrivals = 0;
  let abortedWith: unknown;
  let released = false;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    release();
  };
  return {
    async wait(): Promise<void> {
      arrivals += 1;
      if (arrivals >= participantCount || abortedWith !== undefined) releaseOnce();
      await ready;
      if (abortedWith !== undefined) throw toOrchestratorError(abortedWith);
    },
    abort(error: unknown): void {
      abortedWith ??= error;
      releaseOnce();
    },
  };
}

function pathContains(scope: string, candidate: string): boolean {
  const normalizedScope = scope.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  const normalizedCandidate = candidate.replaceAll("\\", "/").replace(/^\.\//u, "");
  return (
    normalizedCandidate === normalizedScope || normalizedCandidate.startsWith(`${normalizedScope}/`)
  );
}

function deduplicateEvidence(items: readonly Evidence[]): Evidence[] {
  const byFingerprint = new Map<string, Evidence>();
  for (const item of items) {
    const fingerprint = sha256(stableJson(semanticEvidenceInput(item)));
    if (!byFingerprint.has(fingerprint)) byFingerprint.set(fingerprint, item);
  }
  return [...byFingerprint.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const converted = z.toJSONSchema(schema);
  if (converted === null || Array.isArray(converted) || typeof converted !== "object") {
    throw new OrchestratorError("Unable to create read-worker output schema", {
      code: "CONFIGURATION",
    });
  }
  return converted;
}
