import { execa } from "execa";
import { canonicalizeExistingPath } from "../filesystem/path-safety.js";
import { OrchestratorError } from "../../shared/errors.js";

export type GitRepositoryMetadata = {
  repositoryPath: string;
  gitRoot: string;
  headCommit: string;
  currentBranch?: string;
  defaultBranch?: string;
  remotes: Array<{ name: string; urlRedacted: string }>;
};

export type GitWorktree = {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
};

export type GitCommandRecord = {
  cwd: string;
  argv: string[];
  startedAt: string;
  completedAt: string;
  exitCode: number | null;
  stderrExcerpt: string;
};

export type GitClientOptions = {
  observer?: (record: GitCommandRecord) => Promise<void> | void;
};

export class GitClient {
  constructor(private readonly options: GitClientOptions = {}) {}

  async inspectRepository(inputPath: string): Promise<GitRepositoryMetadata> {
    const canonicalInput = await canonicalizeExistingPath(inputPath);
    const rootResult = await this.run(canonicalInput, ["rev-parse", "--show-toplevel"]);
    const gitRoot = await canonicalizeExistingPath(rootResult.trim());
    const headCommit = (await this.run(gitRoot, ["rev-parse", "HEAD"])).trim();
    const currentBranch = await this.runOptional(gitRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const remoteNames = (await this.run(gitRoot, ["remote"]))
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    const remotes = await Promise.all(
      remoteNames.sort().map(async (name) => ({
        name,
        urlRedacted: redactRemoteUrl((await this.run(gitRoot, ["remote", "get-url", name])).trim()),
      })),
    );
    const remoteDefault = await this.runOptional(gitRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]);
    const defaultBranch = remoteDefault?.replace(/^origin\//u, "") ?? currentBranch;

    return {
      repositoryPath: canonicalInput,
      gitRoot,
      headCommit,
      ...(currentBranch === undefined ? {} : { currentBranch }),
      ...(defaultBranch === undefined ? {} : { defaultBranch }),
      remotes,
    };
  }

  async resolveBaseRef(
    gitRoot: string,
    requested: string | undefined,
    metadata: GitRepositoryMetadata,
  ): Promise<string> {
    if (requested !== undefined) {
      if (!(await this.refExists(gitRoot, requested))) {
        throw new OrchestratorError(
          `Requested base ref does not resolve to a commit: ${requested}`,
          {
            code: "PROJECT",
          },
        );
      }
      return requested;
    }
    const candidates = [
      metadata.defaultBranch === undefined ? undefined : `origin/${metadata.defaultBranch}`,
      metadata.defaultBranch,
      metadata.currentBranch,
      "HEAD",
    ].filter((candidate): candidate is string => candidate !== undefined);

    for (const candidate of [...new Set(candidates)]) {
      if (await this.refExists(gitRoot, candidate)) {
        return candidate;
      }
    }
    throw new OrchestratorError("No valid base ref could be resolved for the repository", {
      code: "PROJECT",
    });
  }

  async resolveCommit(gitRoot: string, ref: string): Promise<string> {
    return (await this.run(gitRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).trim();
  }

  async statusPorcelain(gitRoot: string): Promise<string> {
    return this.run(gitRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  }

  async statusPorcelainZ(gitRoot: string): Promise<string> {
    return this.run(gitRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  }

  async listFilesAtCommit(gitRoot: string, commit: string): Promise<string[]> {
    const resolved = await this.resolveCommit(gitRoot, commit);
    return splitNul(await this.run(gitRoot, ["ls-tree", "-r", "--name-only", "-z", resolved]));
  }

  async showFileAtCommit(gitRoot: string, commit: string, path: string): Promise<string> {
    assertSafeGitPath(path);
    const resolved = await this.resolveCommit(gitRoot, commit);
    return this.run(gitRoot, ["show", `${resolved}:${path}`]);
  }

  async changedFilesBetween(
    gitRoot: string,
    fromCommit: string,
    toCommit: string,
  ): Promise<string[]> {
    const from = await this.resolveCommit(gitRoot, fromCommit);
    const to = await this.resolveCommit(gitRoot, toCommit);
    return splitNul(await this.run(gitRoot, ["diff", "--name-only", "-z", from, to, "--"]));
  }

  async branchExists(gitRoot: string, branch: string): Promise<boolean> {
    return this.refExists(gitRoot, `refs/heads/${branch}`);
  }

  async branchHead(gitRoot: string, branch: string): Promise<string> {
    await this.validateBranchName(gitRoot, branch);
    return this.resolveCommit(gitRoot, `refs/heads/${branch}`);
  }

  async isAncestor(gitRoot: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.execute(gitRoot, [
      "merge-base",
      "--is-ancestor",
      ancestor,
      descendant,
    ]);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new OrchestratorError("Git could not evaluate branch ancestry", {
        code: "PROJECT",
        cause: new Error(result.stderr.trim()),
      });
    }
    return result.exitCode === 0;
  }

  async validateBranchName(gitRoot: string, branch: string): Promise<void> {
    await this.run(gitRoot, ["check-ref-format", "--branch", branch]);
  }

  async listWorktrees(gitRoot: string): Promise<GitWorktree[]> {
    const output = await this.run(gitRoot, ["worktree", "list", "--porcelain", "-z"]);
    return parseWorktreeList(output);
  }

  async createWorktree(
    gitRoot: string,
    worktreePath: string,
    branch: string,
    baseCommit: string,
  ): Promise<void> {
    await this.validateBranchName(gitRoot, branch);
    await this.run(gitRoot, [
      "worktree",
      "add",
      "--no-track",
      "-b",
      branch,
      worktreePath,
      baseCommit,
    ]);
  }

  async removeWorktree(gitRoot: string, worktreePath: string, force = false): Promise<void> {
    await this.run(gitRoot, ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath]);
  }

  async deleteMergedBranch(gitRoot: string, branch: string): Promise<void> {
    await this.validateBranchName(gitRoot, branch);
    await this.run(gitRoot, ["branch", "-d", branch]);
  }

  async changedFiles(gitRoot: string, baseCommit: string): Promise<string[]> {
    const [tracked, untracked] = await Promise.all([
      this.run(gitRoot, ["diff", "--name-only", "-z", baseCommit, "--"]),
      this.run(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    return [...new Set([...splitNul(tracked), ...splitNul(untracked)])].sort();
  }

  async diffPatch(gitRoot: string, baseCommit: string): Promise<string> {
    const tracked = await this.run(gitRoot, [
      "diff",
      "--binary",
      "--full-index",
      "--no-ext-diff",
      baseCommit,
      "--",
    ]);
    const untracked = splitNul(
      await this.run(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    );
    const patches = await Promise.all(
      untracked.map(async (path) =>
        this.runAllowing(
          gitRoot,
          ["diff", "--no-index", "--binary", "--", "/dev/null", path],
          [0, 1],
        ),
      ),
    );
    return [tracked, ...patches]
      .filter((part) => part !== "")
      .map((part) => (part.endsWith("\n") ? part : `${part}\n`))
      .join("");
  }

  async diffStat(gitRoot: string, baseCommit: string): Promise<string> {
    const tracked = await this.run(gitRoot, ["diff", "--stat", baseCommit, "--"]);
    const untracked = splitNul(
      await this.run(gitRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    );
    const stats = await Promise.all(
      untracked.map(async (path) =>
        this.runAllowing(
          gitRoot,
          ["diff", "--no-index", "--stat", "--", "/dev/null", path],
          [0, 1],
        ),
      ),
    );
    return [tracked, ...stats].filter((part) => part !== "").join("\n");
  }

  async binaryFiles(gitRoot: string, baseCommit: string): Promise<string[]> {
    const changed = await this.changedFiles(gitRoot, baseCommit);
    const checks = await Promise.all(
      changed.map(async (path) => {
        const output = await this.runAllowing(
          gitRoot,
          ["diff", "--no-index", "--numstat", "--", "/dev/null", path],
          [0, 1],
        );
        if (/^-\s+-\s+/u.test(output)) return path;
        const tracked = await this.run(gitRoot, ["diff", "--numstat", baseCommit, "--", path]);
        return /^-\s+-\s+/u.test(tracked) ? path : undefined;
      }),
    );
    return checks.filter((path): path is string => path !== undefined).sort();
  }

  private async refExists(gitRoot: string, ref: string): Promise<boolean> {
    const result = await this.execute(gitRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    return result.exitCode === 0;
  }

  private async run(gitRoot: string, argv: string[]): Promise<string> {
    const result = await this.execute(gitRoot, argv);
    if (result.exitCode !== 0) {
      throw new OrchestratorError(`Git command failed: git ${argv.join(" ")}`, {
        code: "PROJECT",
        cause: new Error(result.stderr.trim()),
      });
    }
    return result.stdout;
  }

  private async runAllowing(
    gitRoot: string,
    argv: string[],
    allowedExitCodes: readonly number[],
  ): Promise<string> {
    const result = await this.execute(gitRoot, argv);
    if (result.exitCode === undefined || !allowedExitCodes.includes(result.exitCode)) {
      throw new OrchestratorError(`Git command failed: git ${argv.join(" ")}`, {
        code: "PROJECT",
        cause: new Error(result.stderr.trim()),
      });
    }
    return result.stdout;
  }

  private async runOptional(gitRoot: string, argv: string[]): Promise<string | undefined> {
    const result = await this.execute(gitRoot, argv);
    const value = result.stdout.trim();
    return result.exitCode === 0 && value !== "" ? value : undefined;
  }

  private async execute(gitRoot: string, argv: string[]) {
    const startedAt = new Date().toISOString();
    const result = await execa("git", ["-C", gitRoot, ...argv], {
      reject: false,
      timeout: 15_000,
      maxBuffer: 8_000_000,
      stripFinalNewline: false,
    });
    await this.options.observer?.({
      cwd: gitRoot,
      argv: ["git", "-C", gitRoot, ...argv],
      startedAt,
      completedAt: new Date().toISOString(),
      exitCode: result.exitCode ?? null,
      stderrExcerpt: result.stderr.slice(-2_000),
    });
    return result;
  }
}

function splitNul(value: string): string[] {
  return value.split("\0").filter((part) => part !== "");
}

function assertSafeGitPath(path: string): void {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new OrchestratorError(`Unsafe repository-relative Git path: ${path}`, {
      code: "CONTEXT_INTEGRITY",
    });
  }
}

function parseWorktreeList(output: string): GitWorktree[] {
  const records: GitWorktree[] = [];
  let current: Partial<GitWorktree> = {};
  const finish = (): void => {
    if (current.path !== undefined && current.head !== undefined) {
      records.push({
        path: current.path,
        head: current.head,
        detached: current.detached ?? current.branch === undefined,
        ...(current.branch === undefined ? {} : { branch: current.branch }),
      });
    }
    current = {};
  };

  for (const field of output.split("\0")) {
    if (field === "") {
      finish();
    } else if (field.startsWith("worktree ")) {
      current.path = field.slice("worktree ".length);
    } else if (field.startsWith("HEAD ")) {
      current.head = field.slice("HEAD ".length);
    } else if (field.startsWith("branch refs/heads/")) {
      current.branch = field.slice("branch refs/heads/".length);
    } else if (field === "detached") {
      current.detached = true;
    }
  }
  finish();
  return records;
}

export function redactRemoteUrl(input: string): string {
  try {
    const parsed = new URL(input);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const withoutUser = input.replace(/^[^/@\s]+@/u, "");
    return withoutUser.replace(/[?#].*$/u, "");
  }
}
