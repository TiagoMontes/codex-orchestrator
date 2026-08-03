import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiffArtifact } from "../../domain/execution/diff-artifact.js";
import { diffArtifactSchema } from "../../domain/execution/diff-artifact.js";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError } from "../../shared/errors.js";
import { sha256 } from "../../shared/hashing.js";
import { resolveSafePath } from "../filesystem/path-safety.js";
import { AtomicFileWriter } from "../persistence/atomic-file-writer.js";
import { AtomicJsonStore } from "../persistence/atomic-json-store.js";
import type { StatePaths } from "../persistence/state-paths.js";
import { GitClient } from "./git-client.js";

export class DiffService {
  constructor(
    private readonly paths: StatePaths,
    private readonly git = new GitClient(),
    private readonly textWriter = new AtomicFileWriter(),
    private readonly store = new AtomicJsonStore(),
    private readonly clock: Clock = systemClock,
  ) {}

  async capture(input: {
    projectId: string;
    taskId: string;
    worktreePath: string;
    sourceCommit: string;
    baseCommit: string;
  }): Promise<DiffArtifact> {
    const worktreePath = await resolveSafePath(this.paths.worktreesDirectory, input.worktreePath);
    const resolvedBase = await this.git.resolveCommit(worktreePath, input.baseCommit);
    if (resolvedBase !== input.baseCommit || input.sourceCommit !== input.baseCommit) {
      throw new OrchestratorError("Diff source/base commit integrity check failed", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const [worktreeHead, statusPorcelain, changedFiles, binaryFiles, diffStat, patch] =
      await Promise.all([
        this.git.resolveCommit(worktreePath, "HEAD"),
        this.git.statusPorcelain(worktreePath),
        this.git.changedFiles(worktreePath, resolvedBase),
        this.git.binaryFiles(worktreePath, resolvedBase),
        this.git.diffStat(worktreePath, resolvedBase),
        this.git.diffPatch(worktreePath, resolvedBase),
      ]);
    const taskDirectory = this.paths.taskDirectory(input.projectId, input.taskId);
    if (worktreeHead !== resolvedBase) {
      throw new OrchestratorError("Task writers must not create commits in the worktree", {
        code: "CONTEXT_INTEGRITY",
        resumable: true,
      });
    }
    const patchPath = join(taskDirectory, "diff.patch");
    await this.textWriter.writeText(patchPath, patch);
    const artifact = diffArtifactSchema.parse({
      schemaVersion: 1,
      taskId: input.taskId,
      sourceCommit: input.sourceCommit,
      baseCommit: resolvedBase,
      worktreeHead,
      statusPorcelain,
      changedFiles,
      binaryFiles,
      diffStat,
      patchPath,
      diffHash: sha256(patch),
      capturedAt: isoNow(this.clock),
    });
    await this.store.write(join(taskDirectory, "diff.json"), artifact);
    return artifact;
  }

  async read(projectId: string, taskId: string): Promise<DiffArtifact> {
    return this.store.read(
      join(this.paths.taskDirectory(projectId, taskId), "diff.json"),
      diffArtifactSchema,
    );
  }

  async assertCurrent(artifact: DiffArtifact, worktreePath: string): Promise<void> {
    const safePath = await resolveSafePath(this.paths.worktreesDirectory, worktreePath);
    const [head, patch] = await Promise.all([
      this.git.resolveCommit(safePath, "HEAD"),
      this.git.diffPatch(safePath, artifact.baseCommit),
    ]);
    if (head !== artifact.worktreeHead || head !== artifact.baseCommit) {
      throw new OrchestratorError("The worktree HEAD changed after diff capture", {
        code: "CONTEXT_INTEGRITY",
        resumable: true,
      });
    }
    if (sha256(patch) !== artifact.diffHash) {
      throw new OrchestratorError("The worktree diff changed after capture", {
        code: "CONTEXT_INTEGRITY",
        resumable: true,
      });
    }
  }

  async readPersistedPatch(
    artifact: DiffArtifact,
    projectId: string,
    taskId: string,
  ): Promise<string> {
    if (artifact.taskId !== taskId) {
      throw new OrchestratorError("Persisted diff identity mismatch", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    const taskDirectory = this.paths.taskDirectory(projectId, taskId);
    const patchPath = await resolveSafePath(taskDirectory, artifact.patchPath);
    const patch = await readFile(patchPath, "utf8");
    if (sha256(patch) !== artifact.diffHash) {
      throw new OrchestratorError("Persisted diff patch hash is invalid", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    return patch;
  }
}
