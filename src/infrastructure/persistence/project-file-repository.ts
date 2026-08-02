import { access, constants, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { Clock } from "../../shared/clock.js";
import { isoNow, systemClock } from "../../shared/clock.js";
import { OrchestratorError } from "../../shared/errors.js";
import {
  projectIndexSchema,
  projectConfigSchema,
  projectSchema,
  type Project,
  type ProjectConfig,
  type ProjectIndex,
  type VerificationCommand,
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
      const configPath = this.projectConfigFile(project.id);
      const configExists = await exists(configPath);
      const persisted = configExists
        ? {
            ...project,
            verificationPolicy: (await this.readConfig(configPath, project.id)).verification,
          }
        : project;
      if (!configExists) {
        await this.textWriter.writeText(configPath, stringify(toProjectConfig(project)));
      }
      await this.store.write(this.projectFile(project.id), projectSchema.parse(persisted));
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
    const project = await this.store.read(this.projectFile(id), projectSchema);
    const config = await this.readConfig(this.projectConfigFile(id), id);
    return projectSchema.parse({ ...project, verificationPolicy: config.verification });
  }

  private projectFile(id: string): string {
    return join(this.paths.projectDirectory(id), "project.json");
  }

  private projectConfigFile(id: string): string {
    return join(this.paths.projectDirectory(id), "project-config.yaml");
  }

  private async readConfig(path: string, projectId: string): Promise<ProjectConfig> {
    let input: unknown;
    try {
      input = parse(await readFile(path, "utf8")) as unknown;
    } catch (error) {
      throw new OrchestratorError(`Project configuration is not valid YAML: ${path}`, {
        code: "CONFIGURATION",
        cause: error,
      });
    }
    const result = projectConfigSchema.safeParse(input);
    if (!result.success) {
      throw new OrchestratorError(`Project configuration failed validation: ${path}`, {
        code: "CONFIGURATION",
        cause: result.error,
      });
    }
    if (result.data.projectId !== projectId) {
      throw new OrchestratorError(
        `Project configuration identity mismatch: expected ${projectId}, received ${result.data.projectId}`,
        { code: "CONFIGURATION" },
      );
    }
    return result.data;
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

function toProjectConfig(project: Project): Record<string, unknown> {
  const configured = (command: VerificationCommand): Record<string, unknown> => ({
    name: command.name,
    command: command.argv,
    timeoutSeconds: command.timeoutSeconds,
    source: command.source,
    approved: command.approved,
  });
  return {
    schemaVersion: 1,
    projectId: project.id,
    verification: {
      focused: project.verificationPolicy.focused.map(configured),
      full: project.verificationPolicy.full.map(configured),
      candidates: project.verificationPolicy.candidates.map(configured),
    },
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
