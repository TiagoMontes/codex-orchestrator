import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskControlService } from "../../src/application/tasks/task-control-service.js";
import { TaskRunService } from "../../src/application/tasks/task-run-service.js";
import { TaskWorktreeService } from "../../src/application/tasks/task-worktree-service.js";
import type { CodexRuntime } from "../../src/infrastructure/codex/codex-runtime.js";
import { DecisionFileRepository } from "../../src/infrastructure/persistence/decision-file-repository.js";
import { EvidenceFileRepository } from "../../src/infrastructure/persistence/evidence-file-repository.js";
import { ExecutionFileRepository } from "../../src/infrastructure/persistence/execution-file-repository.js";
import { UsageFileRepository } from "../../src/infrastructure/persistence/usage-file-repository.js";
import { VerificationFileRepository } from "../../src/infrastructure/persistence/verification-file-repository.js";
import { createDiagnosedTaskFixture } from "../helpers/diagnosed-task-fixture.js";
import { createGitFixture, gitOutput } from "../helpers/git-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("task cancellation and resume", () => {
  it("aborts an active writer, charges its reservation, and resumes safely", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "cxo-control-repo-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-control-state-"));
    temporaryDirectories.push(repositoryRoot, stateHome);
    await createGitFixture(repositoryRoot);
    const seeded = await createDiagnosedTaskFixture(repositoryRoot, stateHome);
    await writeFile(join(repositoryRoot, "primary-note.md"), "Primary branch advanced.\n", "utf8");
    await gitOutput(repositoryRoot, ["add", "primary-note.md"]);
    await gitOutput(repositoryRoot, ["commit", "-m", "advance primary after diagnosis"]);
    const primaryHead = await gitOutput(repositoryRoot, ["rev-parse", "HEAD"]);
    const primaryStatus = await gitOutput(repositoryRoot, ["status", "--porcelain=v1"]);
    let runtimeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      runtimeStarted = resolve;
    });
    let observedAbort = false;
    const runtime: CodexRuntime = {
      runStructured: (request) => {
        runtimeStarted();
        return new Promise<never>((_resolve, reject) => {
          const abort = (): void => {
            observedAbort = true;
            reject(new Error("cancelled"));
          };
          if (request.abortSignal?.aborted ?? false) abort();
          else request.abortSignal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const executions = new ExecutionFileRepository(seeded.paths);
    const usage = new UsageFileRepository(seeded.paths);
    const verification = new VerificationFileRepository(seeded.paths);
    const worktrees = new TaskWorktreeService(
      seeded.paths,
      seeded.taskRepository,
      seeded.projects,
      seeded.diagnosisRepository,
    );
    const runner = new TaskRunService(
      seeded.config,
      seeded.paths,
      seeded.taskRepository,
      seeded.projects,
      worktrees,
      runtime,
      usage,
      seeded.diagnosisRepository,
      new EvidenceFileRepository(seeded.paths),
      executions,
      new DecisionFileRepository(seeded.paths),
      verification,
    );
    const controller = new TaskControlService(
      seeded.paths,
      seeded.taskRepository,
      seeded.projects,
      seeded.diagnosisRepository,
      verification,
      undefined,
      undefined,
      usage,
      executions,
    );

    const running = runner.run(seeded.task.id);
    await started;
    const cancelled = await controller.cancel(seeded.task.id);
    expect(cancelled.state.status).toBe("cancelled");
    expect((await controller.cancel(seeded.task.id)).idempotent).toBe(true);
    await expect(controller.resume(seeded.task.id)).rejects.toMatchObject({
      code: "TASK_STATE",
      resumable: true,
    });
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });

    expect(observedAbort).toBe(true);
    expect((await seeded.taskRepository.getState(seeded.task.id)).status).toBe("cancelled");
    expect((await executions.list(seeded.project.id, seeded.task.id)).at(-1)?.status).toBe(
      "cancelled",
    );
    expect((await usage.read(seeded.project.id, seeded.task.id)).reservations).toEqual([]);
    expect((await usage.read(seeded.project.id, seeded.task.id)).totalCalls).toBeGreaterThan(0);
    expect(await gitOutput(repositoryRoot, ["rev-parse", "HEAD"])).toBe(primaryHead);
    expect(await gitOutput(repositoryRoot, ["status", "--porcelain=v1"])).toBe(primaryStatus);

    const orphanReservation = await usage.reserve({
      projectId: seeded.project.id,
      taskId: seeded.task.id,
      phase: "implementation",
      projectedTokens: 100,
      maxTotalTokens: 1_000_000,
      maxAgentCalls: 100,
    });
    const priorAttempt = (await executions.list(seeded.project.id, seeded.task.id))[0];
    expect(priorAttempt).toBeDefined();
    if (priorAttempt !== undefined) {
      const interrupted = structuredClone(priorAttempt);
      delete interrupted.completedAt;
      delete interrupted.error;
      delete interrupted.threadId;
      delete interrupted.resultArtifactPath;
      await executions.save(seeded.project.id, {
        ...interrupted,
        id: randomUUID(),
        reservationId: orphanReservation.id,
        startedAt: "2026-08-02T12:09:00.000Z",
        status: "running",
      });
    }
    expect((await usage.read(seeded.project.id, seeded.task.id)).reservations).toHaveLength(1);

    const resumed = await controller.resume(seeded.task.id);
    expect(resumed.state.status).toBe("ready-for-implementation");
    expect(resumed.nextCommand).toBe(`cxo task run ${seeded.task.id}`);
    expect((await usage.read(seeded.project.id, seeded.task.id)).reservations).toEqual([]);
    expect(
      (await executions.list(seeded.project.id, seeded.task.id)).some(
        (attempt) => attempt.status === "running",
      ),
    ).toBe(false);
  });
});
