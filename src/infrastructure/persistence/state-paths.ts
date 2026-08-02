import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { OrchestratorError } from "../../shared/errors.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type StatePathEnvironment = Readonly<Record<string, string | undefined>>;

export class StatePaths {
  readonly home: string;

  constructor(environment: StatePathEnvironment = process.env) {
    const configured = environment.CODEX_ORCHESTRATOR_HOME?.trim();
    this.home =
      configured === undefined || configured === ""
        ? join(homedir(), ".codex-orchestrator")
        : resolve(configured);
  }

  get configFile(): string {
    return join(this.home, "config.yaml");
  }

  get projectsIndexFile(): string {
    return join(this.home, "projects.json");
  }

  get tasksIndexFile(): string {
    return join(this.home, "tasks.json");
  }

  get taskCountersFile(): string {
    return join(this.home, "task-counters.json");
  }

  get projectsDirectory(): string {
    return join(this.home, "projects");
  }

  get worktreesDirectory(): string {
    return join(this.home, "worktrees");
  }

  get locksDirectory(): string {
    return join(this.home, "locks");
  }

  get tempDirectory(): string {
    return join(this.home, "temp");
  }

  projectDirectory(projectId: string): string {
    return join(this.projectsDirectory, assertSafeId(projectId));
  }

  taskDirectory(projectId: string, taskId: string): string {
    return join(this.projectDirectory(projectId), "tasks", assertSafeId(taskId));
  }

  taskWorktree(projectId: string, taskId: string): string {
    return join(this.worktreesDirectory, assertSafeId(projectId), assertSafeId(taskId));
  }

  async ensureBaseDirectories(): Promise<void> {
    await Promise.all(
      [
        this.home,
        this.projectsDirectory,
        this.worktreesDirectory,
        this.locksDirectory,
        this.tempDirectory,
      ].map(async (directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
    );
  }
}

export function assertSafeId(value: string): string {
  if (!SAFE_ID.test(value) || isAbsolute(value) || value === "." || value === "..") {
    throw new OrchestratorError(`Unsafe state identifier: ${value}`, { code: "CONFIGURATION" });
  }
  return value;
}
