import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryLock } from "../../../src/infrastructure/git/repository-lock.js";
import { StatePaths } from "../../../src/infrastructure/persistence/state-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("RepositoryLock", () => {
  it("blocks a second writer for the same repository", async () => {
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-repository-lock-"));
    temporaryDirectories.push(stateHome);
    const locks = new RepositoryLock(new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome }));
    const first = await locks.acquireWriter("demo");

    await expect(locks.acquireWriter("demo")).rejects.toMatchObject({ code: "TASK_STATE" });

    await first.release();
    const next = await locks.acquireWriter("demo");
    await next.release();
  });
});
