import { access, constants, rm } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError } from "../../shared/errors.js";
import {
  projectIndexSchema,
  projectSchema,
  type Project,
  type ProjectIndex,
} from "../../domain/project/project.js";
import { AtomicFileWriter } from "./atomic-file-writer.js";
import { AtomicJsonStore } from "./atomic-json-store.js";
import { FileLockManager } from "./file-lock.js";
import type { StatePaths } from "./state-paths.js";

export class ProjectFileRepository {
  private readonly locks: FileLockManager;

  constructor(
    private readonly paths: StatePaths,
    private readonly store = new AtomicJsonStore(),
    private readonly textWriter = new AtomicFileWriter(),
    private readonly clock: Clock = systemClock,
  ) {
    this.locks = new FileLockManager(paths.locksDirectory);
  }

  async list(): Promise<Project[]> {
    const index = await this.readIndex();
    return Promise.all(index.projectIds.map(async (id) => this.getById(id)));
  }

  async get(reference: string): Promise<Project> {
    const matches = (await this.list()).filter(
      (project) => project.id === reference || project.name === reference,
    );
    if (matches.length === 1) return matches[0] as Project;
    if (matches.length > 1) {
      throw new OrchestratorError(`Project name is ambiguous: ${reference}`, { code: "PROJECT" });
    }
    throw new OrchestratorError(`Project is not registered: ${reference}`, {
      code: "PROJECT",
      nextCommand: "cxo project list",
    });
  }

  async save(project: Project): Promise<void> {
    const lock = await this.locks.acquire("projects:index");
    try {
      const index = await this.readIndex();
      const existing = await this.listFromIndex(index);
      if (existing.some((item) => item.gitRoot === project.gitRoot && item.id !== project.id)) {
        throw new OrchestratorError(`Repository is already registered: ${project.gitRoot}`, {
          code: "PROJECT",
        });
      }
      await this.paths.ensureBaseDirectories();
      await this.store.write(this.projectFile(project.id), projectSchema.parse(project));
      await this.textWriter.writeText(
        join(this.paths.projectDirectory(project.id), "project-config.yaml"),
        stringify({
          schemaVersion: 1,
          projectId: project.id,
          verification: project.verificationPolicy,
        }),
      );
      if (!index.projectIds.includes(project.id)) {
        index.projectIds.push(project.id);
        index.projectIds.sort();
      }
      index.updatedAt = isoNow(this.clock);
      await this.store.write(this.paths.projectsIndexFile, index);
    } finally {
      await lock.release();
    }
  }

  async remove(reference: string): Promise<Project> {
    const lock = await this.locks.acquire("projects:index");
    try {
      const project = await this.get(reference);
      const index = await this.readIndex();
      index.projectIds = index.projectIds.filter((id) => id !== project.id);
      index.updatedAt = isoNow(this.clock);
      await this.store.write(this.paths.projectsIndexFile, index);
      await rm(this.paths.projectDirectory(project.id), { recursive: true, force: true });
      return project;
    } finally {
      await lock.release();
    }
  }

  private async getById(id: string): Promise<Project> {
    return this.store.read(this.projectFile(id), projectSchema);
  }

  private projectFile(id: string): string {
    return join(this.paths.projectDirectory(id), "project.json");
  }

  private async readIndex(): Promise<ProjectIndex> {
    if (!(await exists(this.paths.projectsIndexFile))) {
      return { schemaVersion: 1, projectIds: [], updatedAt: isoNow(this.clock) };
    }
    return this.store.read(this.paths.projectsIndexFile, projectIndexSchema);
  }

  private async listFromIndex(index: ProjectIndex): Promise<Project[]> {
    return Promise.all(index.projectIds.map(async (id) => this.getById(id)));
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
