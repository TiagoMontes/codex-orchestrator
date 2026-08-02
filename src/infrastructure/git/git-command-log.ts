import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { StatePaths } from "../persistence/state-paths.js";
import { LogRedactor } from "../process/log-redactor.js";
import type { GitCommandRecord } from "./git-client.js";

const storedGitCommandSchema = z
  .object({
    schemaVersion: z.literal(1),
    cwd: z.string().min(1),
    argv: z.array(z.string()),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    exitCode: z.number().int().nullable(),
    stderrExcerpt: z.string(),
  })
  .strict();

export class GitCommandLog {
  private readonly redactor = new LogRedactor();

  constructor(private readonly paths: StatePaths) {}

  path(projectId: string, taskId: string): string {
    return join(this.paths.taskDirectory(projectId, taskId), "runs", "git.jsonl");
  }

  async append(projectId: string, taskId: string, record: GitCommandRecord): Promise<void> {
    const path = this.path(projectId, taskId);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const safe = storedGitCommandSchema.parse({
      schemaVersion: 1,
      ...record,
      argv: record.argv.map((value) => this.redactor.redact(value)),
      stderrExcerpt: this.redactor.redact(record.stderrExcerpt).slice(-2_000),
    });
    await appendFile(path, `${JSON.stringify(safe)}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
