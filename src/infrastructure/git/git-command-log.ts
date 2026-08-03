import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { StatePaths } from "../persistence/state-paths.js";
import { LogRedactor } from "../process/log-redactor.js";
import type { GitCommandRecord } from "./git-client.js";
import { ConfigService } from "../../application/configuration/config-service.js";
import { DEFAULT_CONFIG } from "../../application/configuration/default-config.js";

export type GitCommandCorrelation = {
  phase?: string;
  executionId?: string;
  threadId?: string;
};

type GitCommandScope = GitCommandCorrelation & {
  scope: "global" | "project" | "task";
  projectId?: string;
  taskId?: string;
};

const storedGitCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    cwd: z.string().min(1),
    argv: z.array(z.string()),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    exitCode: z.number().int().nullable(),
    stderrExcerpt: z.string(),
    scope: z.enum(["global", "project", "task"]),
    projectId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
    executionId: z.string().min(1).optional(),
    threadId: z.string().min(1).optional(),
  })
  .strict();

export class GitCommandLog {
  private readonly redactor = new LogRedactor();
  private readonly writes = new Map<string, Promise<void>>();

  constructor(
    private readonly paths: StatePaths,
    private readonly maximumBytes: number | (() => number | Promise<number>) = async () =>
      new ConfigService(paths)
        .load()
        .then((config) => config.storage.maxCommandLogBytes)
        .catch(() => DEFAULT_CONFIG.storage.maxCommandLogBytes),
  ) {}

  path(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "runs", "git.jsonl");
  }

  projectPath(projectId: string): string {
    return join(this.paths.projectDirectory(projectId), "runs", "git.jsonl");
  }

  globalPath(): string {
    return join(this.paths.home, "runs", "git.jsonl");
  }

  appendGlobal(record: GitCommandRecord, correlation: GitCommandCorrelation = {}): Promise<void> {
    return this.appendPath(this.globalPath(), record, { scope: "global", ...correlation });
  }

  appendProject(
    projectId: string,
    record: GitCommandRecord,
    correlation: GitCommandCorrelation = {},
  ): Promise<void> {
    return this.appendPath(this.projectPath(projectId), record, {
      scope: "project",
      projectId,
      ...correlation,
    });
  }

  async append(
    projectId: string,
    taskId: string,
    record: GitCommandRecord,
    correlation: GitCommandCorrelation = {},
  ): Promise<void> {
    await this.appendPath(this.path(projectId, taskId), record, {
      scope: "task",
      projectId,
      taskId,
      ...correlation,
    });
  }

  private appendPath(
    path: string,
    record: GitCommandRecord,
    scope: GitCommandScope,
  ): Promise<void> {
    const prior = (this.writes.get(path) ?? Promise.resolve()).catch(() => undefined);
    const write = prior.then(async () => this.appendBounded(path, record, scope));
    this.writes.set(path, write);
    return write.finally(() => {
      if (this.writes.get(path) === write) this.writes.delete(path);
    });
  }

  private async appendBounded(
    path: string,
    record: GitCommandRecord,
    scope: GitCommandScope,
  ): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const safe = storedGitCommandSchema.parse({
      schemaVersion: 1,
      ...record,
      ...scope,
      argv: record.argv.map((value) => this.redactor.redact(value)),
      stderrExcerpt: this.redactor.redact(record.stderrExcerpt).slice(-2_000),
    });
    const line = `${JSON.stringify(safe)}\n`;
    const currentBytes = await stat(path)
      .then((metadata) => metadata.size)
      .catch(() => 0);
    const maximumBytes =
      typeof this.maximumBytes === "number" ? this.maximumBytes : await this.maximumBytes();
    if (currentBytes + Buffer.byteLength(line) > maximumBytes) return;
    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
  }
}
