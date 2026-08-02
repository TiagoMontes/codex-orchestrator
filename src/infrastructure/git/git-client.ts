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

export class GitClient {
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

  private async refExists(gitRoot: string, ref: string): Promise<boolean> {
    const result = await execa(
      "git",
      ["-C", gitRoot, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      {
        reject: false,
        timeout: 10_000,
      },
    );
    return result.exitCode === 0;
  }

  private async run(gitRoot: string, argv: string[]): Promise<string> {
    const result = await execa("git", ["-C", gitRoot, ...argv], {
      reject: false,
      timeout: 15_000,
      maxBuffer: 2_000_000,
    });
    if (result.exitCode !== 0) {
      throw new OrchestratorError(`Git command failed: git ${argv.join(" ")}`, {
        code: "PROJECT",
        cause: new Error(result.stderr.trim()),
      });
    }
    return result.stdout;
  }

  private async runOptional(gitRoot: string, argv: string[]): Promise<string | undefined> {
    const result = await execa("git", ["-C", gitRoot, ...argv], {
      reject: false,
      timeout: 10_000,
    });
    const value = result.stdout.trim();
    return result.exitCode === 0 && value !== "" ? value : undefined;
  }
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
