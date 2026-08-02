import { access, constants, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalizeExistingPath, resolveSafePath } from "../filesystem/path-safety.js";
import type { StatePaths } from "../persistence/state-paths.js";
import { OrchestratorError } from "../../shared/errors.js";
import type { GitWorktree } from "./git-client.js";
import { GitClient } from "./git-client.js";

export type PreparedWorktree = {
  path: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  reused: boolean;
};

export type CleanupWorktreeOptions = {
  force?: boolean;
  deleteBranch?: boolean;
};

export type CleanupWorktreeReport = {
  path: string;
  branch: string;
  branchDeleted: boolean;
};

export class WorktreeManager {
  constructor(
    private readonly paths: StatePaths,
    private readonly git = new GitClient(),
  ) {}

  async prepare(input: {
    projectId: string;
    taskId: string;
    repositoryRoot: string;
    baseCommit: string;
    branch: string;
  }): Promise<PreparedWorktree> {
    await this.paths.ensureBaseDirectories();
    const target = await resolveSafePath(
      this.paths.worktreesDirectory,
      this.paths.taskWorktree(input.projectId, input.taskId),
      { allowMissing: true },
    );
    const baseCommit = await this.git.resolveCommit(input.repositoryRoot, input.baseCommit);
    const existing = await this.findRegistered(input.repositoryRoot, target);
    if (existing !== undefined) {
      return this.validateExisting(existing, input.branch, baseCommit);
    }
    if (await exists(target)) {
      throw new OrchestratorError(`Refusing to overwrite unregistered worktree path: ${target}`, {
        code: "PROJECT",
      });
    }
    if (await this.git.branchExists(input.repositoryRoot, input.branch)) {
      throw new OrchestratorError(`Task branch already exists: ${input.branch}`, {
        code: "PROJECT",
        resumable: true,
      });
    }

    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await this.git.createWorktree(input.repositoryRoot, target, input.branch, baseCommit);
      const canonicalTarget = await canonicalizeExistingPath(target);
      const created = await this.findRegistered(input.repositoryRoot, canonicalTarget);
      if (created === undefined) {
        throw new OrchestratorError("Git did not register the newly created worktree", {
          code: "CONTEXT_INTEGRITY",
        });
      }
      const validated = await this.validateExisting(created, input.branch, baseCommit);
      return { ...validated, reused: false };
    } catch (error) {
      await this.cleanupFailedCreation(input.repositoryRoot, target, input.branch, baseCommit);
      throw error;
    }
  }

  async inspect(repositoryRoot: string, path: string): Promise<GitWorktree> {
    const safePath = await resolveSafePath(this.paths.worktreesDirectory, path);
    const worktree = await this.findRegistered(repositoryRoot, safePath);
    if (worktree === undefined) {
      throw new OrchestratorError(`Path is not a registered worktree: ${safePath}`, {
        code: "PROJECT",
      });
    }
    return worktree;
  }

  async cleanup(
    repositoryRoot: string,
    reference: { path: string; branch: string; baseCommit: string },
    options: CleanupWorktreeOptions = {},
  ): Promise<CleanupWorktreeReport> {
    const safePath = await resolveSafePath(this.paths.worktreesDirectory, reference.path);
    const worktree = await this.inspect(repositoryRoot, safePath);
    if (worktree.branch !== reference.branch) {
      throw new OrchestratorError(
        `Worktree branch mismatch: ${worktree.branch ?? "detached"} != ${reference.branch}`,
        { code: "CONTEXT_INTEGRITY" },
      );
    }
    const status = await this.git.statusPorcelain(safePath);
    if (status !== "" && !(options.force ?? false)) {
      throw new OrchestratorError(
        "Worktree has uncommitted changes; pass the explicit force cleanup flag to remove it",
        { code: "TASK_STATE", resumable: true },
      );
    }
    if (
      (options.deleteBranch ?? false) &&
      !(await this.git.isAncestor(repositoryRoot, reference.branch, "HEAD"))
    ) {
      throw new OrchestratorError(
        "Refusing to delete a task branch with commits not merged into the primary HEAD",
        { code: "TASK_STATE", resumable: true },
      );
    }
    await this.git.removeWorktree(repositoryRoot, safePath, options.force ?? false);

    let branchDeleted = false;
    if (options.deleteBranch ?? false) {
      const stillCheckedOut = (await this.git.listWorktrees(repositoryRoot)).some(
        (item) => item.branch === reference.branch,
      );
      if (stillCheckedOut) {
        throw new OrchestratorError(
          `Refusing to delete branch still used by a worktree: ${reference.branch}`,
          { code: "PROJECT" },
        );
      }
      await this.git.deleteMergedBranch(repositoryRoot, reference.branch);
      branchDeleted = true;
    }
    return { path: safePath, branch: reference.branch, branchDeleted };
  }

  private async validateExisting(
    worktree: GitWorktree,
    branch: string,
    baseCommit: string,
  ): Promise<PreparedWorktree> {
    if (worktree.branch !== branch) {
      throw new OrchestratorError(
        `Existing worktree branch mismatch: ${worktree.branch ?? "detached"} != ${branch}`,
        { code: "CONTEXT_INTEGRITY" },
      );
    }
    const headCommit = await this.git.resolveCommit(worktree.path, "HEAD");
    if (headCommit !== baseCommit) {
      throw new OrchestratorError(
        `Existing worktree HEAD does not match task base: ${headCommit} != ${baseCommit}`,
        { code: "CONTEXT_INTEGRITY", resumable: true },
      );
    }
    if ((await this.git.statusPorcelain(worktree.path)) !== "") {
      throw new OrchestratorError("Existing task worktree is not clean", {
        code: "TASK_STATE",
        resumable: true,
      });
    }
    return {
      path: worktree.path,
      branch,
      baseCommit,
      headCommit,
      reused: true,
    };
  }

  private async findRegistered(
    repositoryRoot: string,
    target: string,
  ): Promise<GitWorktree | undefined> {
    const canonicalTarget = await canonicalizeExistingPath(target).catch(() => target);
    const worktrees = await this.git.listWorktrees(repositoryRoot);
    for (const worktree of worktrees) {
      const canonicalPath = await canonicalizeExistingPath(worktree.path).catch(
        () => worktree.path,
      );
      if (canonicalPath === canonicalTarget) return { ...worktree, path: canonicalPath };
    }
    return undefined;
  }

  private async cleanupFailedCreation(
    repositoryRoot: string,
    target: string,
    branch: string,
    baseCommit: string,
  ): Promise<void> {
    const registered = await this.findRegistered(repositoryRoot, target).catch(() => undefined);
    if (registered !== undefined && registered.branch === branch) {
      await this.git.removeWorktree(repositoryRoot, registered.path, true).catch(() => undefined);
    }
    if (
      (await this.git.branchExists(repositoryRoot, branch).catch(() => false)) &&
      (await this.git.resolveCommit(repositoryRoot, branch).catch(() => undefined)) === baseCommit
    ) {
      await this.git.deleteMergedBranch(repositoryRoot, branch).catch(() => undefined);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
