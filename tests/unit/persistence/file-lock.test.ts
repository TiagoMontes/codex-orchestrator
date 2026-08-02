import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileLockManager } from "../../../src/infrastructure/persistence/file-lock.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("FileLockManager", () => {
  it("blocks a concurrent owner and permits acquisition after release", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-lock-"));
    temporaryDirectories.push(directory);
    const manager = new FileLockManager(directory);
    const acquired = await manager.acquire("task:one");

    await expect(manager.acquire("task:one")).rejects.toMatchObject({
      code: "TASK_STATE",
      resumable: true,
    });

    await acquired.release();
    const next = await manager.acquire("task:one");
    await next.release();
  });

  it("recovers an expired lock only when its process is gone", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cxo-lock-"));
    temporaryDirectories.push(directory);
    const now = new Date("2026-08-02T12:00:00.000Z");
    const manager = new FileLockManager(directory, {
      staleAfterMs: 1_000,
      clock: { now: () => now },
      processIsRunning: () => false,
    });
    await writeFile(
      manager.pathForKey("task:stale"),
      JSON.stringify({
        schemaVersion: 1,
        key: "task:stale",
        token: "05f70eca-3d06-4e25-8c87-ca4e0792773e",
        pid: 999_999,
        createdAt: "2026-08-02T11:00:00.000Z",
      }),
      "utf8",
    );

    const acquired = await manager.acquire("task:stale");
    await acquired.release();
  });
});
