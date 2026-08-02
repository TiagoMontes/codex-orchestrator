import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Clock } from "../../shared/clock.js";
import { systemClock } from "../../shared/clock.js";
import { OrchestratorError } from "../../shared/errors.js";
import { sha256 } from "../../shared/hashing.js";

const lockMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    key: z.string(),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    createdAt: z.string().datetime(),
  })
  .strict();

type LockMetadata = z.infer<typeof lockMetadataSchema>;

export interface AcquiredLock {
  readonly path: string;
  readonly token: string;
  release(): Promise<void>;
}

export type FileLockManagerOptions = {
  staleAfterMs?: number;
  clock?: Clock;
  pid?: number;
  processIsRunning?: (pid: number) => boolean;
};

export class FileLockManager {
  private readonly staleAfterMs: number;
  private readonly clock: Clock;
  private readonly pid: number;
  private readonly processIsRunning: (pid: number) => boolean;

  constructor(
    private readonly locksDirectory: string,
    options: FileLockManagerOptions = {},
  ) {
    this.staleAfterMs = options.staleAfterMs ?? 30 * 60 * 1_000;
    this.clock = options.clock ?? systemClock;
    this.pid = options.pid ?? process.pid;
    this.processIsRunning = options.processIsRunning ?? isProcessRunning;
  }

  pathForKey(key: string): string {
    return join(this.locksDirectory, `${sha256(key).slice(0, 32)}.lock`);
  }

  async acquire(key: string): Promise<AcquiredLock> {
    await mkdir(this.locksDirectory, { recursive: true, mode: 0o700 });
    const path = this.pathForKey(key);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = randomUUID();
      const metadata: LockMetadata = {
        schemaVersion: 1,
        key,
        token,
        pid: this.pid,
        createdAt: this.clock.now().toISOString(),
      };
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let created = false;
      try {
        handle = await open(path, "wx", 0o600);
        created = true;
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        return {
          path,
          token,
          release: async () => this.release(path, token),
        };
      } catch (error) {
        await handle?.close().catch(() => undefined);
        if (created) {
          await unlink(path).catch(() => undefined);
        }
        if (!isAlreadyExistsError(error) || attempt > 0 || !(await this.recoverIfStale(path))) {
          throw new OrchestratorError(`State mutation is locked: ${key}`, {
            code: "TASK_STATE",
            resumable: true,
            cause: error,
          });
        }
      }
    }

    throw new OrchestratorError(`Unable to acquire state lock: ${key}`, { code: "TASK_STATE" });
  }

  private async recoverIfStale(path: string): Promise<boolean> {
    let metadata: LockMetadata;
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      metadata = lockMetadataSchema.parse(raw);
    } catch {
      return false;
    }

    const age = this.clock.now().getTime() - Date.parse(metadata.createdAt);
    if (age <= this.staleAfterMs || this.processIsRunning(metadata.pid)) {
      return false;
    }

    await unlink(path);
    return true;
  }

  private async release(path: string, token: string): Promise<void> {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    const current = lockMetadataSchema.parse(raw);
    if (current.token !== token) {
      throw new OrchestratorError("Refusing to release a lock owned by another process", {
        code: "TASK_STATE",
      });
    }
    await unlink(path);
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
