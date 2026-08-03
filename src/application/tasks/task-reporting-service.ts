import { access, constants, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Diagnosis } from "../../domain/diagnosis/diagnosis.js";
import type { DiffArtifact } from "../../domain/execution/diff-artifact.js";
import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";
import type { ExecutionPhase } from "../../domain/execution/execution.js";
import type { ReviewResult } from "../../domain/review/review.js";
import type { Task } from "../../domain/task/task.js";
import type { TaskStateDocument } from "../../domain/task/task-state.js";
import type { UsageLedgerDocument } from "../../domain/usage/usage-ledger.js";
import type { VerificationResult } from "../../domain/verification/verification.js";
import { resolveSafePath } from "../../infrastructure/filesystem/path-safety.js";
import { DiffService } from "../../infrastructure/git/diff-service.js";
import { GitClientFactory } from "../../infrastructure/git/git-client-factory.js";
import type {
  DecisionEntry,
  DecisionFileRepository,
} from "../../infrastructure/persistence/decision-file-repository.js";
import type { DiagnosisFileRepository } from "../../infrastructure/persistence/diagnosis-file-repository.js";
import type { ExecutionFileRepository } from "../../infrastructure/persistence/execution-file-repository.js";
import type { ReviewFileRepository } from "../../infrastructure/persistence/review-file-repository.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import type { TaskFileRepository } from "../../infrastructure/persistence/task-file-repository.js";
import type { UsageFileRepository } from "../../infrastructure/persistence/usage-file-repository.js";
import type { VerificationFileRepository } from "../../infrastructure/persistence/verification-file-repository.js";
import { OrchestratorError } from "../../shared/errors.js";
import { sha256 } from "../../shared/hashing.js";
import type { ProjectManager } from "../projects/project-service.js";
import { verificationPolicyHash } from "./verification-policy.js";
import { contextPackSchema, type ContextPack } from "../../orchestration/context/context-pack.js";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

export type TaskStatusReport = {
  task: Task;
  state: TaskStateDocument;
  attempts: ExecutionAttempt[];
  latestAttempt?: ExecutionAttempt;
  usage: UsageLedgerDocument;
  usageBreakdown: Array<{
    phase: ExecutionPhase;
    model: string;
    calls: number;
    totalTokens: number;
  }>;
  threads: string[];
  retryCount: number;
  retries: Array<{
    executionId: string;
    phase: ExecutionPhase;
    attemptNumber: number;
    reason: string;
  }>;
  contextRotations: Array<{
    executionId: string;
    phase: ExecutionPhase;
    threadId?: string;
    compacted: boolean;
    reasons: string[];
  }>;
  artifacts: {
    diagnosis?: Diagnosis;
    diff?: DiffArtifact;
    verification?: VerificationResult;
    review?: ReviewResult;
  };
  decisions: DecisionEntry[];
  limitations: string[];
  integrity: {
    artifactRelationshipsValid: true;
    liveDiffCurrent?: boolean;
  };
  nextCommand?: string;
};

export type TaskDiffReport = {
  taskId: string;
  diff: DiffArtifact;
  live: boolean;
  verified: boolean;
  stat?: string;
  patch?: string;
};

export type TaskLogReport = {
  taskId: string;
  phase?: ExecutionPhase;
  tail: number;
  records: Array<{
    source: "agent" | "verification";
    phase: ExecutionPhase;
    executionId?: string;
    path: string;
    line: string;
  }>;
};

export interface TaskReporter {
  status(taskId: string): Promise<TaskStatusReport>;
  diff(taskId: string, options?: { stat?: boolean; patch?: boolean }): Promise<TaskDiffReport>;
  logs(taskId: string, options?: { phase?: ExecutionPhase; tail?: number }): Promise<TaskLogReport>;
}

export class TaskReportingService implements TaskReporter {
  private readonly gitClients: GitClientFactory;

  constructor(
    private readonly paths: StatePaths,
    private readonly tasks: TaskFileRepository,
    private readonly diagnoses: DiagnosisFileRepository,
    private readonly executions: ExecutionFileRepository,
    private readonly usageRepository: UsageFileRepository,
    private readonly verificationRepository: VerificationFileRepository,
    private readonly reviews: ReviewFileRepository,
    private readonly decisions: DecisionFileRepository,
    private readonly projects: ProjectManager,
  ) {
    this.gitClients = new GitClientFactory(paths);
  }

  async status(taskId: string): Promise<TaskStatusReport> {
    const { task, state } = await this.tasks.getSnapshot(taskId);
    if (task.status !== state.status) {
      throw new OrchestratorError("Task and state documents disagree", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const [attempts, usage, diagnosis, diff, verification, review, decisions] = await Promise.all([
      this.executions.list(task.projectId, task.id),
      this.usageRepository.read(task.projectId, task.id),
      this.readOptional(this.diagnoses.path(task.projectId, task.id), async () =>
        this.diagnoses.read(task.projectId, task.id),
      ),
      this.readOptional(
        join(this.paths.taskDirectory(task.projectId, task.id), "diff.json"),
        async () =>
          new DiffService(
            this.paths,
            this.gitClients.task(task.projectId, task.id, { phase: "reporting" }),
          ).read(task.projectId, task.id),
      ),
      this.readOptional(
        join(this.paths.taskDirectory(task.projectId, task.id), "verification.json"),
        async () => this.verificationRepository.read(task.projectId, task.id),
      ),
      this.readOptional(
        join(this.paths.taskDirectory(task.projectId, task.id), "review.json"),
        async () => this.reviews.read(task.projectId, task.id),
      ),
      this.decisions.list(task.projectId, task.id),
    ]);
    assertArtifactRelationships(task, diagnosis, diff, verification, review);
    const liveDiffCurrent =
      diff === undefined || task.worktree === undefined
        ? undefined
        : await new DiffService(
            this.paths,
            this.gitClients.task(task.projectId, task.id, { phase: "reporting" }),
          )
            .assertCurrent(diff, task.worktree.path)
            .then(() => true)
            .catch(() => false);
    const latestAttempt = attempts.at(-1);
    const suggestedNextCommand = nextCommand(state);
    const contextPacks = await this.readContextPacks(task, attempts);
    const retries = attempts
      .filter((attempt) => attempt.phase !== "exploration" && attempt.attemptNumber > 1)
      .map((attempt) => ({
        executionId: attempt.id,
        phase: attempt.phase,
        attemptNumber: attempt.attemptNumber,
        reason:
          contextPacks.get(attempt.id)?.latestFailure ??
          attempt.error?.message ??
          "Retry admitted after a changed evidence fingerprint",
      }));
    const contextRotations = attempts.flatMap((attempt) => {
      const pack = contextPacks.get(attempt.id);
      if (pack === undefined || !pack.contextPolicy.threadRotated) return [];
      return [
        {
          executionId: attempt.id,
          phase: attempt.phase,
          ...(attempt.threadId === undefined ? {} : { threadId: attempt.threadId }),
          compacted: pack.contextPolicy.compacted,
          reasons: pack.contextPolicy.reasons,
        },
      ];
    });
    return {
      task,
      state,
      attempts,
      ...(latestAttempt === undefined ? {} : { latestAttempt }),
      usage,
      usageBreakdown: usageBreakdown(usage),
      threads: [
        ...new Set([
          ...usage.entries.flatMap((entry) => entry.threadId ?? []),
          ...attempts.flatMap((attempt) => attempt.threadId ?? []),
        ]),
      ],
      retryCount: retries.length,
      retries,
      contextRotations,
      artifacts: {
        ...(diagnosis === undefined ? {} : { diagnosis }),
        ...(diff === undefined ? {} : { diff }),
        ...(verification === undefined ? {} : { verification }),
        ...(review === undefined ? {} : { review }),
      },
      decisions,
      limitations: knownLimitations({
        ...(diagnosis === undefined ? {} : { diagnosis }),
        ...(verification === undefined ? {} : { verification }),
        ...(review === undefined ? {} : { review }),
        state,
        ...(liveDiffCurrent === undefined ? {} : { liveDiffCurrent }),
      }),
      integrity: {
        artifactRelationshipsValid: true,
        ...(liveDiffCurrent === undefined ? {} : { liveDiffCurrent }),
      },
      ...(suggestedNextCommand === undefined ? {} : { nextCommand: suggestedNextCommand }),
    };
  }

  async diff(
    taskId: string,
    options: { stat?: boolean; patch?: boolean } = {},
  ): Promise<TaskDiffReport> {
    const task = await this.tasks.get(taskId);
    const diffService = new DiffService(
      this.paths,
      this.gitClients.task(task.projectId, task.id, { phase: "reporting" }),
    );
    const artifact = await diffService.read(task.projectId, task.id);
    if (
      artifact.taskId !== task.id ||
      task.baseCommit === undefined ||
      artifact.sourceCommit !== task.baseCommit ||
      artifact.baseCommit !== task.baseCommit
    ) {
      throw new OrchestratorError("Persisted diff is not bound to the task source", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const taskDirectory = this.paths.taskDirectory(task.projectId, task.id);
    const patch = await diffService.readPersistedPatch(artifact, task.projectId, task.id);
    const live = task.worktree !== undefined && (await exists(task.worktree.path));
    if (live && task.worktree !== undefined) {
      await diffService.assertCurrent(artifact, task.worktree.path);
    }
    const verification = await this.readOptional(
      join(taskDirectory, "verification.json"),
      async () => this.verificationRepository.read(task.projectId, task.id),
    );
    const project = await this.projects.inspect(task.projectId);
    const verified =
      verification?.overallStatus === "passed" &&
      verification.taskId === task.id &&
      verification.sourceCommit === artifact.sourceCommit &&
      verification.diffHash === artifact.diffHash &&
      verification.policyHash === verificationPolicyHash(project);
    return {
      taskId,
      diff: artifact,
      live,
      verified,
      ...(options.stat === true ? { stat: artifact.diffStat } : {}),
      ...(options.patch === true ? { patch } : {}),
    };
  }

  async logs(
    taskId: string,
    options: { phase?: ExecutionPhase; tail?: number } = {},
  ): Promise<TaskLogReport> {
    const task = await this.tasks.get(taskId);
    const tail = options.tail ?? 50;
    if (!Number.isInteger(tail) || tail < 1 || tail > 1_000) {
      throw new OrchestratorError("Log tail must be an integer from 1 through 1000", {
        code: "CLI_INPUT",
      });
    }
    const taskDirectory = this.paths.taskDirectory(task.projectId, task.id);
    const attempts = (await this.executions.list(task.projectId, task.id)).filter(
      (attempt) => options.phase === undefined || attempt.phase === options.phase,
    );
    const records: TaskLogReport["records"] = [];
    for (const attempt of attempts) {
      const path = await resolveSafePath(taskDirectory, attempt.eventsPath);
      if (!(await exists(path))) continue;
      const lines = (await readFile(path, "utf8")).split(/\r?\n/u).filter(Boolean);
      records.push(
        ...lines.map((line) => ({
          source: "agent" as const,
          phase: attempt.phase,
          executionId: attempt.id,
          path,
          line: sanitizeLogLine(line),
        })),
      );
    }
    if (options.phase === undefined || options.phase === "verification") {
      const verification = await this.readOptional(
        join(taskDirectory, "verification.json"),
        async () => this.verificationRepository.read(task.projectId, task.id),
      );
      for (const command of verification?.commands ?? []) {
        const path = await resolveSafePath(taskDirectory, command.logPath);
        const contents = await readFile(path, "utf8");
        if (sha256(contents) !== command.logSha256) {
          throw new OrchestratorError(`Verification log hash is invalid: ${command.name}`, {
            code: "CONTEXT_INTEGRITY",
          });
        }
        records.push(
          ...contents
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => ({
              source: "verification" as const,
              phase: "verification" as const,
              path,
              line: sanitizeLogLine(line),
            })),
        );
      }
    }
    return {
      taskId,
      ...(options.phase === undefined ? {} : { phase: options.phase }),
      tail,
      records: records.slice(-tail),
    };
  }

  private async readOptional<T>(path: string, read: () => Promise<T>): Promise<T | undefined> {
    return (await exists(path)) ? read() : undefined;
  }

  private async readContextPacks(
    task: Task,
    attempts: readonly ExecutionAttempt[],
  ): Promise<Map<string, ContextPack>> {
    const taskDirectory = this.paths.taskDirectory(task.projectId, task.id);
    const pairs = await Promise.all(
      attempts.map(async (attempt) => {
        try {
          const path = await resolveSafePath(taskDirectory, attempt.contextPackPath);
          const pack = contextPackSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
          return [attempt.id, pack] as const;
        } catch {
          return undefined;
        }
      }),
    );
    return new Map(pairs.filter((pair): pair is NonNullable<typeof pair> => pair !== undefined));
  }
}

function assertArtifactRelationships(
  task: Task,
  diagnosis: Diagnosis | undefined,
  diff: DiffArtifact | undefined,
  verification: VerificationResult | undefined,
  review: ReviewResult | undefined,
): void {
  const sourceCommit = task.baseCommit;
  const invalid =
    (diagnosis !== undefined &&
      (diagnosis.taskId !== task.id ||
        sourceCommit === undefined ||
        diagnosis.sourceCommit !== sourceCommit)) ||
    (diff !== undefined &&
      (diff.taskId !== task.id ||
        sourceCommit === undefined ||
        diff.sourceCommit !== sourceCommit ||
        diff.baseCommit !== sourceCommit)) ||
    (verification !== undefined &&
      (verification.taskId !== task.id ||
        sourceCommit === undefined ||
        verification.sourceCommit !== sourceCommit ||
        diff === undefined ||
        verification.diffHash !== diff.diffHash)) ||
    (review !== undefined &&
      (review.taskId !== task.id ||
        sourceCommit === undefined ||
        review.sourceCommit !== sourceCommit ||
        diff === undefined ||
        review.reviewedDiffHash !== diff.diffHash));
  if (invalid) {
    throw new OrchestratorError("Persisted task artifacts have incompatible identities", {
      code: "CONTEXT_INTEGRITY",
    });
  }
}

function sanitizeLogLine(line: string): string {
  return [...line.replace(ANSI_SEQUENCE, "")]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 9 || (code >= 32 && code !== 127);
    })
    .join("")
    .slice(0, 4_000);
}

function usageBreakdown(ledger: UsageLedgerDocument): TaskStatusReport["usageBreakdown"] {
  const totals = new Map<string, TaskStatusReport["usageBreakdown"][number]>();
  for (const entry of ledger.entries) {
    const key = `${entry.phase}\0${entry.model}`;
    const current = totals.get(key) ?? {
      phase: entry.phase,
      model: entry.model,
      calls: 0,
      totalTokens: 0,
    };
    current.calls += entry.agentCalls;
    current.totalTokens += entry.usage.totalTokens;
    totals.set(key, current);
  }
  return [...totals.values()].sort((left, right) =>
    `${left.phase}:${left.model}`.localeCompare(`${right.phase}:${right.model}`),
  );
}

function knownLimitations(input: {
  diagnosis?: Diagnosis;
  verification?: VerificationResult;
  review?: ReviewResult;
  state: TaskStateDocument;
  liveDiffCurrent?: boolean;
}): string[] {
  const limitations = new Set<string>([
    "No merge or push is performed automatically.",
    "Only explicitly approved verification argv run, and a missing host sandbox blocks execution.",
  ]);
  if (input.diagnosis !== undefined) {
    for (const blocker of input.diagnosis.reproduction.blockers) {
      limitations.add(`Diagnosis reproduction blocker: ${blocker}`);
    }
    for (const hypothesis of input.diagnosis.activeHypotheses) {
      limitations.add(`Unresolved diagnosis hypothesis: ${hypothesis.statement}`);
    }
    if (input.diagnosis.status !== "confirmed") {
      limitations.add(`Diagnosis remains ${input.diagnosis.status}: ${input.diagnosis.nextAction}`);
    }
  }
  if (input.verification !== undefined && input.verification.overallStatus !== "passed") {
    limitations.add(`Deterministic verification is ${input.verification.overallStatus}.`);
    for (const command of input.verification.commands.filter((item) => item.status !== "passed")) {
      limitations.add(`Verification ${command.name} is ${command.status}.`);
    }
  }
  if (input.review !== undefined && input.review.verdict !== "approve") {
    limitations.add(`Independent review verdict is ${input.review.verdict}.`);
    for (const finding of input.review.findings) {
      limitations.add(`Review finding [${finding.severity}]: ${finding.title}`);
    }
    for (const assessment of input.review.acceptanceCriteriaAssessment.filter(
      (item) => item.status !== "met",
    )) {
      limitations.add(
        `Acceptance criterion ${assessment.criterionId} is ${assessment.status}: ${assessment.explanation}`,
      );
    }
  }
  if (input.state.status === "blocked" || input.state.status === "cancelled") {
    const latest = input.state.transitions.at(-1);
    limitations.add(
      `Task is ${input.state.status}${latest === undefined ? "." : `: ${latest.reason}`}`,
    );
  }
  if (input.liveDiffCurrent === false) {
    limitations.add("The live worktree no longer matches the latest persisted diff.");
  }
  return [...limitations];
}

function nextCommand(state: TaskStateDocument): string | undefined {
  if (state.status === "ready-for-diagnosis") return `cxo task diagnose ${state.taskId}`;
  if (state.status === "diagnosed" || state.status === "ready-for-implementation") {
    return `cxo task run ${state.taskId}`;
  }
  if (state.status === "reviewing") return `cxo task review ${state.taskId}`;
  if (state.status === "blocked" || state.status === "cancelled") {
    return `cxo task resume ${state.taskId}`;
  }
  if (state.status === "completed") return `cxo task diff ${state.taskId}`;
  return undefined;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
