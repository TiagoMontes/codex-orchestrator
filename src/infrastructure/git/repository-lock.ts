import type { AcquiredLock } from "../persistence/file-lock.js";
import { FileLockManager } from "../persistence/file-lock.js";
import type { StatePaths } from "../persistence/state-paths.js";

export class RepositoryLock {
  private readonly locks: FileLockManager;

  constructor(paths: StatePaths) {
    this.locks = new FileLockManager(paths.locksDirectory);
  }

  acquireWriter(projectId: string): Promise<AcquiredLock> {
    return this.locks.acquire(`repository-writer:${projectId}`);
  }
}
