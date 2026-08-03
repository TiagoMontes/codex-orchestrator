import type { StatePaths } from "../persistence/state-paths.js";
import { GitClient } from "./git-client.js";
import { GitCommandLog, type GitCommandCorrelation } from "./git-command-log.js";

/** Creates Git clients whose every attempted command is durably redacted and bounded. */
export class GitClientFactory {
  private readonly log: GitCommandLog;

  constructor(paths: StatePaths, maximumBytes?: number | (() => number | Promise<number>)) {
    this.log =
      maximumBytes === undefined
        ? new GitCommandLog(paths)
        : new GitCommandLog(paths, maximumBytes);
  }

  global(correlation: GitCommandCorrelation = {}): GitClient {
    return new GitClient({
      observer: async (record) => this.log.appendGlobal(record, correlation),
    });
  }

  project(projectId: string, correlation: GitCommandCorrelation = {}): GitClient {
    return new GitClient({
      observer: async (record) => this.log.appendProject(projectId, record, correlation),
    });
  }

  task(projectId: string, taskId: string, correlation: GitCommandCorrelation = {}): GitClient {
    return new GitClient({
      observer: async (record) => this.log.append(projectId, taskId, record, correlation),
    });
  }
}
