import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskCleanupService } from "../../src/application/tasks/task-cleanup-service.js";
import { TaskReportingService } from "../../src/application/tasks/task-reporting-service.js";
import { TaskWorktreeService } from "../../src/application/tasks/task-worktree-service.js";
import { DecisionFileRepository } from "../../src/infrastructure/persistence/decision-file-repository.js";
import { ExecutionFileRepository } from "../../src/infrastructure/persistence/execution-file-repository.js";
import { ReviewFileRepository } from "../../src/infrastructure/persistence/review-file-repository.js";
import { UsageFileRepository } from "../../src/infrastructure/persistence/usage-file-repository.js";
import { VerificationFileRepository } from "../../src/infrastructure/persistence/verification-file-repository.js";
import { TaskStateMachine } from "../../src/orchestration/engine/state-machine.js";
import { createGitFixture, gitOutput } from "../helpers/git-fixture.js";
import { createImplementedTaskFixture } from "../helpers/implemented-task-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("task reports and cleanup", () => {
  it("aggregates status, validates exact diffs, bounds logs, and detects patch tampering", async () => {
    const seeded = await createFixture("report");
    const reporter = createReporter(seeded);

    const status = await reporter.status(seeded.task.id);
    expect(status).toMatchObject({
      state: { status: "reviewing" },
      integrity: { artifactRelationshipsValid: true, liveDiffCurrent: true },
      retryCount: 0,
    });
    expect(status.artifacts.diagnosis?.taskId).toBe(seeded.task.id);
    expect(status.artifacts.verification?.overallStatus).toBe("passed");
    expect(status.usageBreakdown.some((item) => item.phase === "implementation")).toBe(true);
    expect(status.threads).toContain("fixture-implementation-thread");

    const diff = await reporter.diff(seeded.task.id, { stat: true, patch: true });
    expect(diff).toMatchObject({ live: true, verified: true });
    expect(diff.stat).toContain("index.js");
    expect(diff.patch).toContain("publicValue = 2");

    const logs = await reporter.logs(seeded.task.id, { phase: "verification", tail: 2 });
    expect(logs.records.length).toBeGreaterThan(0);
    expect(logs.records.length).toBeLessThanOrEqual(2);
    expect(logs.records.every((record) => record.phase === "verification")).toBe(true);
    await expect(reporter.logs(seeded.task.id, { tail: 0 })).rejects.toMatchObject({
      code: "CLI_INPUT",
    });

    await writeFile(seeded.runReport.diff.patchPath, "tampered patch\n", "utf8");
    await expect(reporter.diff(seeded.task.id, { patch: true })).rejects.toMatchObject({
      code: "CONTEXT_INTEGRITY",
    });
  });

  it("treats explicit completed-task cleanup as authorization while retaining the patch", async () => {
    const seeded = await createFixture("cleanup");
    const state = await seeded.taskRepository.getState(seeded.task.id);
    const completedAt = "2026-08-02T12:08:00.000Z";
    const completedState = new TaskStateMachine().transition(state, {
      nextState: "completed",
      timestamp: completedAt,
      reason: "fixture review approved",
      actor: "agent",
    });
    const currentTask = await seeded.taskRepository.get(seeded.task.id);
    await seeded.taskRepository.update(
      {
        ...currentTask,
        status: "completed",
        revision: currentTask.revision + 1,
        updatedAt: completedAt,
      },
      completedState,
    );
    const worktreePath = currentTask.worktree?.path;
    expect(worktreePath).toBeDefined();
    const patchBefore = await readFile(seeded.runReport.diff.patchPath, "utf8");
    const primaryHead = await gitOutput(seeded.project.gitRoot, ["rev-parse", "HEAD"]);
    const primaryStatus = await gitOutput(seeded.project.gitRoot, ["status", "--porcelain=v1"]);
    const worktrees = new TaskWorktreeService(
      seeded.paths,
      seeded.taskRepository,
      seeded.projects,
      seeded.diagnosisRepository,
    );
    const cleaner = new TaskCleanupService(
      seeded.paths,
      seeded.taskRepository,
      new ExecutionFileRepository(seeded.paths),
      worktrees,
    );

    expect(await cleaner.cleanup(seeded.task.id)).toMatchObject({
      dryRun: true,
      removed: false,
      hasWorktree: true,
    });
    const removed = await cleaner.cleanup(seeded.task.id, { removeWorktree: true });
    expect(removed).toMatchObject({ dryRun: false, removed: true, branchDeleted: false });
    await expect(access(worktreePath ?? "")).rejects.toBeDefined();
    expect(await readFile(seeded.runReport.diff.patchPath, "utf8")).toBe(patchBefore);
    expect(await gitOutput(seeded.project.gitRoot, ["rev-parse", "HEAD"])).toBe(primaryHead);
    expect(await gitOutput(seeded.project.gitRoot, ["status", "--porcelain=v1"])).toBe(
      primaryStatus,
    );
  });
});

async function createFixture(label: string) {
  const repositoryRoot = await mkdtemp(join(tmpdir(), `cxo-${label}-repo-`));
  const stateHome = await mkdtemp(join(tmpdir(), `cxo-${label}-state-`));
  temporaryDirectories.push(repositoryRoot, stateHome);
  await createGitFixture(repositoryRoot);
  return createImplementedTaskFixture(repositoryRoot, stateHome);
}

type ImplementedFixture = Awaited<ReturnType<typeof createImplementedTaskFixture>>;

function createReporter(seeded: ImplementedFixture): TaskReportingService {
  return new TaskReportingService(
    seeded.paths,
    seeded.taskRepository,
    seeded.diagnosisRepository,
    new ExecutionFileRepository(seeded.paths),
    new UsageFileRepository(seeded.paths),
    new VerificationFileRepository(seeded.paths),
    new ReviewFileRepository(seeded.paths),
    new DecisionFileRepository(seeded.paths),
  );
}
