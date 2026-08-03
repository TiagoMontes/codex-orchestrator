import { join } from "node:path";
import type { AppConfig } from "../configuration/config-schema.js";
import type { DiffArtifact } from "../../domain/execution/diff-artifact.js";
import type { Evidence } from "../../domain/evidence/evidence.js";
import type { Project, VerificationCommand } from "../../domain/project/project.js";
import type { Task } from "../../domain/task/task.js";
import type {
  VerificationCommandResult,
  VerificationResult,
} from "../../domain/verification/verification.js";
import { verificationResultSchema } from "../../domain/verification/verification.js";
import type { DiffService } from "../../infrastructure/git/diff-service.js";
import type { EvidenceFileRepository } from "../../infrastructure/persistence/evidence-file-repository.js";
import type { StatePaths } from "../../infrastructure/persistence/state-paths.js";
import type { VerificationFileRepository } from "../../infrastructure/persistence/verification-file-repository.js";
import { CommandRunner } from "../../infrastructure/process/command-runner.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError } from "../../shared/errors.js";
import { sha256, stableJson } from "../../shared/hashing.js";
import { failureSignature } from "../../orchestration/engine/failure-signature.js";
import { approvedVerificationCommands, verificationPolicyHash } from "./verification-policy.js";

export type VerificationRunReport = {
  result: VerificationResult;
  evidence: Evidence[];
  failureSignature?: string;
};

export class VerificationService {
  private readonly runner: CommandRunner;

  constructor(
    private readonly config: AppConfig,
    private readonly paths: StatePaths,
    private readonly evidenceRepository: EvidenceFileRepository,
    private readonly verificationRepository: VerificationFileRepository,
    private readonly diffService: DiffService,
    private readonly clock: Clock = systemClock,
    runner?: CommandRunner,
  ) {
    this.runner = runner ?? new CommandRunner(config, clock);
  }

  async verify(input: {
    task: Task;
    project: Project;
    worktreePath: string;
    diff: DiffArtifact;
    executionId: string;
    abortSignal?: AbortSignal;
  }): Promise<VerificationRunReport> {
    const startedAt = isoNow(this.clock);
    const approved = approvedVerificationCommands(input.project);
    const policyHash = verificationPolicyHash(input.project);
    if (approved.length === 0) {
      const result = verificationResultSchema.parse({
        schemaVersion: 1,
        taskId: input.task.id,
        sourceCommit: input.diff.sourceCommit,
        diffHash: input.diff.diffHash,
        policyHash,
        overallStatus: "blocked",
        commands: [],
        startedAt,
        completedAt: isoNow(this.clock),
      });
      await this.verificationRepository.save(input.project.id, result, input.executionId);
      return { result, evidence: [] };
    }

    await this.diffService.assertCurrent(input.diff, input.worktreePath);
    const commandResults: VerificationCommandResult[] = [];
    const evidence: Evidence[] = [];
    let cancelled = false;
    for (const [index, command] of approved.entries()) {
      const logPath = join(
        this.paths.taskDirectory(input.project.id, input.task.id),
        "logs",
        `verification-${input.executionId}-${index + 1}.log`,
      );
      const raw = await this.runner.run({
        argv: command.argv,
        cwd: input.worktreePath,
        timeoutMs: command.timeoutSeconds * 1_000,
        logPath,
        additionalAllowedEnvironmentNames: input.project.environmentPolicy.allowlist,
        explicitSecretEnvironmentExceptions: input.project.environmentPolicy.secretExceptions,
        ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
      });
      cancelled ||= raw.aborted;
      let status: VerificationCommandResult["status"] =
        raw.spawnError !== undefined || raw.sandboxError !== undefined || raw.aborted
          ? "blocked"
          : raw.exitCode === 0 && !raw.timedOut
            ? "passed"
            : "failed";
      let excerpt = [raw.excerpt, raw.spawnError].filter((value) => value !== undefined).join("\n");
      try {
        await this.diffService.assertCurrent(input.diff, input.worktreePath);
      } catch {
        status = "blocked";
        excerpt = `${excerpt}\n[orchestrator] Verification command changed the captured diff`;
      }
      const evidenceId = verificationEvidenceId(input.task.id, index, command, input.diff.diffHash);
      const result: VerificationCommandResult = {
        name: command.name,
        argv: command.argv,
        startedAt: raw.startedAt,
        completedAt: raw.completedAt,
        exitCode: raw.exitCode,
        ...(raw.signal === undefined ? {} : { signal: raw.signal }),
        timedOut: raw.timedOut,
        status,
        logPath: raw.logPath,
        logSha256: raw.logSha256,
        excerpt: excerpt.slice(-this.config.context.maxExcerptCharacters),
        evidenceId,
      };
      commandResults.push(result);
      evidence.push({
        id: evidenceId,
        taskId: input.task.id,
        kind: command.name.toLowerCase().includes("test") ? "test" : "command",
        status: "confirmed",
        statement: `Configured verification command ${command.name} ${status}`,
        sourceCommit: input.diff.sourceCommit,
        command: command.argv.join(" "),
        ...(raw.exitCode === null ? {} : { exitCode: raw.exitCode }),
        excerpt: result.excerpt,
        artifactPath: raw.logPath,
        sha256: raw.logSha256,
        observedAt: raw.completedAt,
      });
      if (status !== "passed") break;
    }
    const overallStatus = commandResults.some((command) => command.status === "blocked")
      ? "blocked"
      : commandResults.every((command) => command.status === "passed")
        ? "passed"
        : "failed";
    const result = verificationResultSchema.parse({
      schemaVersion: 1,
      taskId: input.task.id,
      sourceCommit: input.diff.sourceCommit,
      diffHash: input.diff.diffHash,
      policyHash,
      overallStatus,
      commands: commandResults,
      startedAt,
      completedAt: isoNow(this.clock),
    });
    await this.verificationRepository.save(input.project.id, result, input.executionId);
    await this.evidenceRepository.merge(input.project.id, input.task.id, evidence);
    if (cancelled) {
      throw new OrchestratorError("Deterministic verification was cancelled", {
        code: "CANCELLED",
        resumable: true,
      });
    }
    if (overallStatus === "passed") {
      return { result, evidence };
    }
    return {
      result,
      evidence,
      failureSignature: failureSignature({
        phase: "verification",
        sourceCommit: result.sourceCommit,
        diffHash: result.diffHash,
        commands: result.commands,
        worktreePath: input.worktreePath,
      }),
    };
  }
}

function verificationEvidenceId(
  taskId: string,
  index: number,
  command: VerificationCommand,
  diffHash: string,
): string {
  if (taskId === "") {
    throw new OrchestratorError("Cannot create verification evidence without a task", {
      code: "VERIFICATION",
    });
  }
  return `V-${index + 1}-${sha256(stableJson({ taskId, argv: command.argv, diffHash })).slice(0, 12)}`;
}
