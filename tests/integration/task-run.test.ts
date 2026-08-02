import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TaskRunService } from "../../src/application/tasks/task-run-service.js";
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
import { createGitFixture, gitOutput } from "../helpers/git-fixture.js";

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
    const seeded = await createDiagnosedTaskFixture(fixture, stateHome);
    const beforeHead = await gitOutput(fixture, ["rev-parse", "HEAD"]);
    const beforeStatus = await gitOutput(fixture, ["status", "--porcelain=v1"]);
    let capturedWorkingDirectory: string | undefined;
    let capturedSandbox: string | undefined;
    const runtime: CodexRuntime = {
      runStructured: async (request) => {
        capturedWorkingDirectory = request.workingDirectory;
        capturedSandbox = request.sandboxMode;
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
  });

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

  it("blocks before the writer when the diagnosed source commit is stale", async () => {
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

    await expect(createRunner(seeded, runtime).run(seeded.task.id)).rejects.toMatchObject({
      code: "CONTEXT_INTEGRITY",
      message: "Primary source commit changed after diagnosis",
    });

    expect(calls).toBe(0);
    expect((await seeded.taskRepository.getState(seeded.task.id)).status).toBe("blocked");
  });
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
    { now: () => new Date("2026-08-02T12:03:00.000Z") },
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
