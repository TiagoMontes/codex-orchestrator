import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRunService } from "../../src/application/tasks/task-run-service.js";
import { TaskControlService } from "../../src/application/tasks/task-control-service.js";
import { TaskWorktreeService } from "../../src/application/tasks/task-worktree-service.js";
import type {
  CodexRunRequest,
  CodexRunResult,
  CodexRuntime,
} from "../../src/infrastructure/codex/codex-runtime.js";
import { DecisionFileRepository } from "../../src/infrastructure/persistence/decision-file-repository.js";
import { EvidenceFileRepository } from "../../src/infrastructure/persistence/evidence-file-repository.js";
import { ExecutionFileRepository } from "../../src/infrastructure/persistence/execution-file-repository.js";
import { UsageFileRepository } from "../../src/infrastructure/persistence/usage-file-repository.js";
import { VerificationFileRepository } from "../../src/infrastructure/persistence/verification-file-repository.js";
import { normalizeFailureText } from "../../src/orchestration/engine/failure-signature.js";
import { createDiagnosedTaskFixture } from "../helpers/diagnosed-task-fixture.js";
import { createImplementedTaskFixture } from "../helpers/implemented-task-fixture.js";
import { createGitFixture, gitOutput } from "../helpers/git-fixture.js";
import { OrchestratorError } from "../../src/shared/errors.js";
import { TaskStateMachine } from "../../src/orchestration/engine/state-machine.js";
import type { Task } from "../../src/domain/task/task.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("task run", () => {
  it("writes only in the worktree and trusts actual deterministic verification", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-run-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-run-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const skillPath = join(fixture, ".agents", "skills", "fixture-skill", "SKILL.md");
    await writeFile(
      skillPath,
      "---\nname: fixture-skill\ndescription: Apply the historical fixture rule.\ntags: [implementation]\n---\n\nHistorical worktree instructions.\n",
      "utf8",
    );
    await gitOutput(fixture, ["add", ".agents/skills/fixture-skill/SKILL.md"]);
    await gitOutput(fixture, ["commit", "-m", "test: add historical implementation skill"]);
    const seeded = await createDiagnosedTaskFixture(fixture, stateHome);
    await writeFile(join(fixture, "AGENTS.md"), "# New primary instructions\n", "utf8");
    await writeFile(
      skillPath,
      "---\nname: fixture-skill\ndescription: Apply a future fixture rule.\ntags: [implementation]\n---\n\nFuture primary instructions.\n",
      "utf8",
    );
    await writeFile(join(fixture, "primary-note.md"), "Primary branch advanced.\n", "utf8");
    await gitOutput(fixture, ["add", "AGENTS.md", ".agents", "primary-note.md"]);
    await gitOutput(fixture, ["commit", "-m", "advance primary after diagnosis"]);
    const beforeHead = await gitOutput(fixture, ["rev-parse", "HEAD"]);
    const beforeStatus = await gitOutput(fixture, ["status", "--porcelain=v1"]);
    let capturedWorkingDirectory: string | undefined;
    let capturedSandbox: string | undefined;
    let capturedPrompt = "";
    const runtime: CodexRuntime = {
      runStructured: async (request) => {
        capturedWorkingDirectory = request.workingDirectory;
        capturedSandbox = request.sandboxMode;
        capturedPrompt = request.prompt;
        await writeFile(
          join(request.workingDirectory, "index.js"),
          "export const publicValue = 2;\n",
          "utf8",
        );
        await writeFile(
          join(request.workingDirectory, "test", "index.test.js"),
          'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { publicValue } from "../index.js";\ntest("public value", () => assert.equal(publicValue, 2));\n',
          "utf8",
        );
        const output = {
          schemaVersion: 1,
          taskId: seeded.task.id,
          status: "changed",
          summary: "Updated the fixture value and its regression assertion",
          advisoryChangedFiles: ["index.js", "test/index.test.js"],
          testsAddedOrUpdated: ["test/index.test.js"],
          unresolvedRisks: [],
          completedAt: "2026-08-02T12:03:00.000Z",
        };
        return {
          threadId: "implementation-thread",
          output: request.outputValidator.parse(output),
          eventsPath: request.eventsPath,
          usage: {
            inputTokens: 1_200,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 300,
            reasoningOutputTokens: 50,
            totalTokens: 1_500,
            source: "actual",
          },
          finalResponse: JSON.stringify(output),
          runtimeAttempts: 1,
          compatibility: {
            sdkVersion: "0.146.0",
            requestedReasoning: request.reasoningPreset,
            mappedReasoning:
              request.reasoningPreset === "deepest" ? "xhigh" : request.reasoningPreset,
            fallbackApplied: false,
            missingUsageFields: [],
          },
        };
      },
    };
    const evidence = new EvidenceFileRepository(seeded.paths);
    const executions = new ExecutionFileRepository(seeded.paths);
    const usage = new UsageFileRepository(seeded.paths);
    const worktrees = new TaskWorktreeService(
      seeded.paths,
      seeded.taskRepository,
      seeded.projects,
      seeded.diagnosisRepository,
      { now: () => new Date("2026-08-02T12:02:00.000Z") },
    );
    const service = new TaskRunService(
      seeded.config,
      seeded.paths,
      seeded.taskRepository,
      seeded.projects,
      worktrees,
      runtime,
      usage,
      seeded.diagnosisRepository,
      evidence,
      executions,
      new DecisionFileRepository(seeded.paths),
      new VerificationFileRepository(seeded.paths),
      { now: () => new Date("2026-08-02T12:03:00.000Z") },
    );

    const report = await service.run(seeded.task.id);

    expect(capturedSandbox).toBe("workspace-write");
    expect(capturedWorkingDirectory).toBe(report.task.worktree?.path);
    expect(capturedWorkingDirectory).not.toBe(fixture);
    expect(capturedPrompt).toContain("Historical worktree instructions.");
    expect(capturedPrompt).not.toContain("Future primary instructions.");
    expect(report.task.status).toBe("reviewing");
    expect(report.diff.changedFiles).toEqual(["index.js", "test/index.test.js"]);
    expect(report.verification.overallStatus).toBe("passed");
    expect(report.verification.commands).toHaveLength(1);
    expect(report.verification.commands[0]).toMatchObject({
      argv: ["node", "--test"],
      exitCode: 0,
      timedOut: false,
      status: "passed",
    });
    expect(report.verification.diffHash).toBe(report.diff.diffHash);
    expect(report.verification.sourceCommit).toBe(seeded.sourceCommit);
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]).toMatchObject({
      threadId: "implementation-thread",
      sandboxMode: "workspace-write",
      status: "succeeded",
    });
    expect(report.usage.totalCalls).toBe(1);
    expect(await readFile(join(fixture, "index.js"), "utf8")).toBe(
      "export const publicValue = 1;\n",
    );
    expect(await gitOutput(fixture, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await gitOutput(fixture, ["status", "--porcelain=v1"])).toBe(beforeStatus);
    expect(
      await readFile(
        join(stateHome, "projects", "demo", "tasks", seeded.task.id, "verification.json"),
        "utf8",
      ),
    ).toContain(report.diff.diffHash);
  });

  it("uses a new correction thread with the latest real failure evidence", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-correction-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-correction-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const seeded = await createDiagnosedTaskFixture(fixture, stateHome);
    const roles: string[] = [];
    const prompts: string[] = [];
    let calls = 0;
    const runtime: CodexRuntime = {
      runStructured: async (request) => {
        calls += 1;
        roles.push(request.role);
        prompts.push(request.prompt);
        if (calls === 1) {
          await writeFile(
            join(request.workingDirectory, "index.js"),
            "export const publicValue = 2;\n",
            "utf8",
          );
        } else {
          await writeFile(
            join(request.workingDirectory, "test", "index.test.js"),
            'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { publicValue } from "../index.js";\ntest("public value", () => assert.equal(publicValue, 2));\n',
            "utf8",
          );
        }
        return implementationResponse(request, seeded.task.id, `writer-thread-${calls}`);
      },
    };

    const report = await createRunner(seeded, runtime).run(seeded.task.id);

    expect(report.verification.overallStatus).toBe("passed");
    expect(report.attempts).toHaveLength(2);
    expect(report.attempts.map((attempt) => attempt.threadId)).toEqual([
      "writer-thread-1",
      "writer-thread-2",
    ]);
    expect(roles).toEqual(["implementer", "corrector"]);
    expect(prompts[1]).toContain("Latest deterministic failure");
    expect(prompts[1]).toContain("public value");
    expect(report.usage.totalCalls).toBe(2);
    expect(
      (await seeded.taskRepository.getState(seeded.task.id)).transitions.map(
        (transition) => transition.nextState,
      ),
    ).toEqual(
      expect.arrayContaining([
        "implementing",
        "verifying",
        "implementing",
        "verifying",
        "reviewing",
      ]),
    );
  }, 15_000);

  it("continues from a terminal failed writer with fresh correction evidence", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-failed-writer-resume-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-failed-writer-resume-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const seeded = await createDiagnosedTaskFixture(fixture, stateHome);
    const roles: string[] = [];
    const prompts: string[] = [];
    let calls = 0;
    const runtime: CodexRuntime = {
      runStructured: async (request) => {
        calls += 1;
        roles.push(request.role);
        prompts.push(request.prompt);
        if (calls === 1) {
          await writeFile(
            join(request.workingDirectory, "index.js"),
            "export const publicValue = 2;\n",
            "utf8",
          );
        } else {
          await writeFile(
            join(request.workingDirectory, "test", "index.test.js"),
            'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { publicValue } from "../index.js";\ntest("public value", () => assert.equal(publicValue, 2));\n',
            "utf8",
          );
        }
        return implementationResponse(request, seeded.task.id, `resumed-writer-${calls}`);
      },
    };
    const usage = new UsageFileRepository(seeded.paths);
    const executions = new ExecutionFileRepository(seeded.paths);
    const verification = new VerificationFileRepository(seeded.paths);

    await expect(
      createRunner(seeded, runtime).run(seeded.task.id, { profile: "economy" }),
    ).rejects.toMatchObject({
      code: "VERIFICATION",
      message: "Implementation stopped: attempt_limit_reached",
    });
    expect(calls).toBe(1);
    expect(
      (await executions.list(seeded.project.id, seeded.task.id)).find(
        (attempt) => attempt.phase === "implementation",
      )?.status,
    ).toBe("failed");

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
    await controller.resume(seeded.task.id);
    const report = await createRunner(seeded, runtime).run(seeded.task.id, {
      profile: "quality",
    });

    expect(report.verification.overallStatus).toBe("passed");
    expect(calls).toBe(2);
    expect(roles).toEqual(["implementer", "corrector"]);
    expect(prompts[1]).toContain("Latest deterministic failure");
    expect(prompts[1]).toContain("public value");
    expect((await usage.read(seeded.project.id, seeded.task.id)).totalCalls).toBe(2);
  }, 20_000);

  it("blocks after an identical deterministic failure instead of trusting agent claims", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-repeated-failure-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-repeated-failure-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const seeded = await createDiagnosedTaskFixture(fixture, stateHome);
    let calls = 0;
    const runtime: CodexRuntime = {
      runStructured: async (request) => {
        calls += 1;
        await writeFile(
          join(request.workingDirectory, "index.js"),
          "export const publicValue = 2;\n",
          "utf8",
        );
        return implementationResponse(request, seeded.task.id, `claim-success-${calls}`);
      },
    };

    await expect(createRunner(seeded, runtime).run(seeded.task.id)).rejects.toMatchObject({
      code: "VERIFICATION",
      message: "Implementation stopped: repeated_failure_without_new_evidence",
    });

    expect(calls).toBe(2);
    const state = await seeded.taskRepository.getState(seeded.task.id);
    const persistedTask = await seeded.taskRepository.get(seeded.task.id);
    expect(state.status).toBe("blocked");
    const attempts = (
      await new ExecutionFileRepository(seeded.paths).list(seeded.project.id, seeded.task.id)
    ).filter((attempt) => attempt.phase === "implementation" || attempt.phase === "correction");
    expect(attempts).toHaveLength(2);
    const excerpts = await Promise.all(
      attempts.map(async (attempt) => {
        const raw = JSON.parse(
          await readFile(
            join(
              seeded.paths.taskDirectory(seeded.project.id, seeded.task.id),
              "runs",
              `${attempt.id}.verification.json`,
            ),
            "utf8",
          ),
        ) as { commands: Array<{ excerpt: string }> };
        return normalizeFailureText(raw.commands[0]?.excerpt ?? "", persistedTask.worktree?.path);
      }),
    );
    expect(excerpts[0]).toBe(excerpts[1]);
    expect(state.transitions.at(-1)?.reason).toBe("repeated_failure_without_new_evidence");
    expect(attempts[0]?.failureSignature).toBe(attempts[1]?.failureSignature);
    expect(
      (await new VerificationFileRepository(seeded.paths).read(seeded.project.id, seeded.task.id))
        .overallStatus,
    ).toBe("failed");
  });

  it("rejects a base-ref override that does not match the diagnosed source", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-source-mismatch-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-source-mismatch-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const seeded = await createDiagnosedTaskFixture(fixture, stateHome);
    await writeFile(join(fixture, "drift.txt"), "new primary commit\n", "utf8");
    await gitOutput(fixture, ["add", "drift.txt"]);
    await gitOutput(fixture, ["commit", "-m", "chore: advance primary fixture"]);
    let calls = 0;
    const runtime: CodexRuntime = {
      runStructured: (request) => {
        calls += 1;
        return Promise.resolve(implementationResponse(request, seeded.task.id, "unexpected"));
      },
    };

    await expect(
      createRunner(seeded, runtime).run(seeded.task.id, { baseRef: "HEAD" }),
    ).rejects.toMatchObject({
      code: "CONTEXT_INTEGRITY",
      message: "The base-ref override does not match the diagnosis source",
    });

    expect(calls).toBe(0);
    expect((await seeded.taskRepository.getState(seeded.task.id)).status).toBe("failed");
  });

  it("charges failed runtime calls and rejects an identical retry without new evidence", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-runtime-retry-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-runtime-retry-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const seeded = await createDiagnosedTaskFixture(fixture, stateHome);
    let calls = 0;
    const runtime: CodexRuntime = {
      runStructured: () => {
        calls += 1;
        throw new OrchestratorError("stable runtime stack trace", {
          code: "CODEX_RUNTIME",
          resumable: true,
        });
      },
    };
    const usage = new UsageFileRepository(seeded.paths);
    const executions = new ExecutionFileRepository(seeded.paths);
    const verification = new VerificationFileRepository(seeded.paths);
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

    await expect(
      createRunner(seeded, runtime).run(seeded.task.id, { profile: "quality" }),
    ).rejects.toMatchObject({
      code: "CODEX_RUNTIME",
    });
    await controller.resume(seeded.task.id);
    await expect(
      createRunner(seeded, runtime).run(seeded.task.id, { profile: "quality" }),
    ).rejects.toMatchObject({
      code: "CODEX_RUNTIME",
    });
    await controller.resume(seeded.task.id);
    await expect(
      createRunner(seeded, runtime).run(seeded.task.id, { profile: "quality" }),
    ).rejects.toMatchObject({
      code: "TASK_STATE",
      message:
        "Implementation retry requires new deterministic evidence or changed commit-scoped context",
    });

    expect(calls).toBe(2);
    expect((await usage.read(seeded.project.id, seeded.task.id)).totalCalls).toBe(4);
    expect(
      (await executions.list(seeded.project.id, seeded.task.id)).filter(
        (attempt) => attempt.phase === "implementation" || attempt.phase === "correction",
      ),
    ).toHaveLength(2);
  }, 15_000);

  it("finalizes a passing writer checkpoint without another model call", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-writer-replay-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-writer-replay-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const seeded = await createImplementedTaskFixture(fixture, stateHome);
    const executions = new ExecutionFileRepository(seeded.paths);
    const priorAttempt = (await executions.list(seeded.project.id, seeded.task.id)).find(
      (attempt) => attempt.phase === "implementation",
    );
    expect(priorAttempt).toBeDefined();
    if (priorAttempt === undefined) throw new Error("missing writer attempt");
    const recoveredArtifactPath = priorAttempt.resultArtifactPath;
    if (recoveredArtifactPath === undefined) throw new Error("missing writer artifact path");
    await rm(recoveredArtifactPath);
    await expect(
      readFile(
        join(
          seeded.paths.taskDirectory(seeded.project.id, seeded.task.id),
          "runs",
          `${priorAttempt.id}.writer-runtime-checkpoint.json`,
        ),
        "utf8",
      ),
    ).resolves.toContain("fixture-implementation-thread");
    const { completedAt, error, resultArtifactPath, threadId, usage, ...runningAttempt } =
      priorAttempt;
    void completedAt;
    void error;
    void resultArtifactPath;
    void threadId;
    void usage;
    await executions.save(seeded.project.id, { ...runningAttempt, status: "running" });
    const task = await seeded.taskRepository.get(seeded.task.id);
    let state = await seeded.taskRepository.getState(seeded.task.id);
    const stateMachine = new TaskStateMachine();
    const blockedAt = "2026-08-02T12:07:00.000Z";
    state = stateMachine.transition(state, {
      nextState: "blocked",
      timestamp: blockedAt,
      reason: "Simulated interruption after the writer checkpoint",
      actor: "system",
    });
    let replayTask: Task = {
      ...task,
      status: "blocked" as const,
      revision: task.revision + 1,
      updatedAt: blockedAt,
    };
    await seeded.taskRepository.update(replayTask, state);
    const timestamp = "2026-08-02T12:08:00.000Z";
    state = stateMachine.transition(state, {
      nextState: "ready-for-implementation",
      timestamp,
      reason: "Resume the interrupted writer checkpoint",
      actor: "user",
    });
    replayTask = {
      ...replayTask,
      status: "ready-for-implementation",
      revision: replayTask.revision + 1,
      updatedAt: timestamp,
    };
    await seeded.taskRepository.update(replayTask, state);
    let calls = 0;
    const runtime: CodexRuntime = {
      runStructured: () => {
        calls += 1;
        throw new Error("writer must not run during checkpoint recovery");
      },
    };

    const report = await createRunner(seeded, runtime).run(seeded.task.id);

    expect(calls).toBe(0);
    expect(report.task.status).toBe("reviewing");
    expect(report.verification.overallStatus).toBe("passed");
    await expect(readFile(recoveredArtifactPath, "utf8")).resolves.toContain(
      "Updated the value and regression assertion",
    );
    expect(await executions.read(seeded.project.id, seeded.task.id, priorAttempt.id)).toMatchObject(
      {
        status: "succeeded",
        threadId: "fixture-implementation-thread",
      },
    );
  }, 15_000);
});

type Seeded = Awaited<ReturnType<typeof createDiagnosedTaskFixture>>;

function createRunner(seeded: Seeded, runtime: CodexRuntime): TaskRunService {
  const worktrees = new TaskWorktreeService(
    seeded.paths,
    seeded.taskRepository,
    seeded.projects,
    seeded.diagnosisRepository,
    { now: () => new Date("2026-08-02T12:02:00.000Z") },
  );
  return new TaskRunService(
    seeded.config,
    seeded.paths,
    seeded.taskRepository,
    seeded.projects,
    worktrees,
    runtime,
    new UsageFileRepository(seeded.paths),
    seeded.diagnosisRepository,
    new EvidenceFileRepository(seeded.paths),
    new ExecutionFileRepository(seeded.paths),
    new DecisionFileRepository(seeded.paths),
    new VerificationFileRepository(seeded.paths),
  );
}

function implementationResponse<T>(
  request: CodexRunRequest<T>,
  taskId: string,
  threadId: string,
): CodexRunResult<T> {
  const output = {
    schemaVersion: 1,
    taskId,
    status: "changed",
    summary: "Agent claims the requested implementation is complete",
    advisoryChangedFiles: ["index.js"],
    testsAddedOrUpdated: [],
    unresolvedRisks: [],
    completedAt: "2026-08-02T12:03:00.000Z",
  };
  return {
    threadId,
    output: request.outputValidator.parse(output),
    eventsPath: request.eventsPath,
    usage: {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 200,
      reasoningOutputTokens: 25,
      totalTokens: 1_200,
      source: "actual",
    },
    finalResponse: JSON.stringify(output),
    runtimeAttempts: 1,
    compatibility: {
      sdkVersion: "0.146.0",
      requestedReasoning: request.reasoningPreset,
      mappedReasoning: request.reasoningPreset === "deepest" ? "xhigh" : request.reasoningPreset,
      fallbackApplied: false,
      missingUsageFields: [],
    },
  };
}
