import { basename } from "node:path";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { sha256 } from "../../shared/hashing.js";
import { OrchestratorError } from "../../shared/errors.js";
import { projectSchema, type Project } from "../../domain/project/project.js";
import type { Task } from "../../domain/task/task.js";
import { GitClient } from "../../infrastructure/git/git-client.js";
import type { ProjectFileRepository } from "../../infrastructure/persistence/project-file-repository.js";
import { StackDetector } from "./stack-detector.js";
import { ProjectMetadataScanner } from "./project-metadata-scanner.js";

export interface ProjectManager {
  add(input: { path: string; name?: string; baseRef?: string }): Promise<Project>;
  list(): Promise<Project[]>;
  inspect(reference: string): Promise<Project>;
  remove(reference: string): Promise<Project>;
}

export class ProjectService implements ProjectManager {
  constructor(
    private readonly repository: ProjectFileRepository,
    private readonly git = new GitClient(),
    private readonly stackDetector = new StackDetector(),
    private readonly metadataScanner = new ProjectMetadataScanner(),
    private readonly clock: Clock = systemClock,
    private readonly tasks?: {
      list(projectId?: string): Promise<Task[]>;
      removeProjectEntries(projectId: string): Promise<number>;
    },
  ) {}

  async add(input: { path: string; name?: string; baseRef?: string }): Promise<Project> {
    const gitMetadata = await this.git.inspectRepository(input.path);
    const existing = (await this.repository.list()).find(
      (project) => project.gitRoot === gitMetadata.gitRoot,
    );
    if (existing !== undefined) {
      throw new OrchestratorError(`Repository is already registered as ${existing.id}`, {
        code: "PROJECT",
      });
    }
    const baseRef = await this.git.resolveBaseRef(gitMetadata.gitRoot, input.baseRef, gitMetadata);
    await this.git.resolveCommit(gitMetadata.gitRoot, baseRef);
    const [{ stack, verificationPolicy }, metadata] = await Promise.all([
      this.stackDetector.detect(gitMetadata.gitRoot),
      this.metadataScanner.scan(gitMetadata.gitRoot),
    ]);
    const name = input.name?.trim() || basename(gitMetadata.gitRoot);
    const id = await this.uniqueId(name, gitMetadata.gitRoot);
    const timestamp = isoNow(this.clock);
    const project = projectSchema.parse({
      schemaVersion: 1,
      id,
      name,
      repositoryPath: gitMetadata.repositoryPath,
      gitRoot: gitMetadata.gitRoot,
      baseRef,
      registeredHeadCommit: gitMetadata.headCommit,
      currentHeadCommit: gitMetadata.headCommit,
      ...(gitMetadata.currentBranch === undefined
        ? {}
        : { currentBranch: gitMetadata.currentBranch }),
      ...(gitMetadata.defaultBranch === undefined
        ? {}
        : { defaultBranch: gitMetadata.defaultBranch }),
      remotes: gitMetadata.remotes,
      detectedStack: stack,
      instructionFiles: metadata.instructionFiles,
      skillMetadata: metadata.skillMetadata,
      verificationPolicy,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.repository.save(project);
    return project;
  }

  list(): Promise<Project[]> {
    return this.repository.list();
  }

  inspect(reference: string): Promise<Project> {
    return this.repository.get(reference);
  }

  async remove(reference: string): Promise<Project> {
    const project = await this.repository.get(reference);
    const tasks = await this.tasks?.list(project.id);
    const taskWithWorktree = tasks?.find((task) => task.worktree !== undefined);
    if (taskWithWorktree !== undefined) {
      throw new OrchestratorError(
        `Project ${project.id} still owns task worktree ${taskWithWorktree.id}`,
        { code: "PROJECT", nextCommand: `cxo task cleanup ${taskWithWorktree.id}` },
      );
    }
    const active = tasks?.find((task) =>
      [
        "normalizing",
        "diagnosing",
        "worktree-preparing",
        "implementing",
        "verifying",
        "reviewing",
        "correcting",
      ].includes(task.status),
    );
    if (active !== undefined) {
      throw new OrchestratorError(`Project ${project.id} still has active task ${active.id}`, {
        code: "PROJECT",
        nextCommand: `cxo task cancel ${active.id}`,
      });
    }
    await this.tasks?.removeProjectEntries(project.id);
    return this.repository.remove(project.id);
  }

  private async uniqueId(name: string, gitRoot: string): Promise<string> {
    const base = slugify(name);
    const existingIds = new Set((await this.repository.list()).map((project) => project.id));
    if (!existingIds.has(base)) return base;
    return `${base}-${sha256(gitRoot).slice(0, 8)}`;
  }
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return slug === "" ? "project" : slug;
}
