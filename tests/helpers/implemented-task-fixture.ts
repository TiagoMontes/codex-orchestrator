import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskRunService } from "../../src/application/tasks/task-run-service.js";
import { TaskWorktreeService } from "../../src/application/tasks/task-worktree-service.js";
import type { CodexRuntime } from "../../src/infrastructure/codex/codex-runtime.js";
import { DecisionFileRepository } from "../../src/infrastructure/persistence/decision-file-repository.js";
import { EvidenceFileRepository } from "../../src/infrastructure/persistence/evidence-file-repository.js";
import { ExecutionFileRepository } from "../../src/infrastructure/persistence/execution-file-repository.js";
import { UsageFileRepository } from "../../src/infrastructure/persistence/usage-file-repository.js";
import { VerificationFileRepository } from "../../src/infrastructure/persistence/verification-file-repository.js";
import { createDiagnosedTaskFixture } from "./diagnosed-task-fixture.js";

export async function createImplementedTaskFixture(repositoryRoot: string, stateHome: string) {
  const seeded = await createDiagnosedTaskFixture(repositoryRoot, stateHome);
  const runtime: CodexRuntime = {
    runStructured: async (request) => {
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
        summary: "Updated the value and regression assertion",
        advisoryChangedFiles: ["index.js", "test/index.test.js"],
        testsAddedOrUpdated: ["test/index.test.js"],
        unresolvedRisks: [],
        completedAt: "2026-08-02T12:03:00.000Z",
      };
      return {
        threadId: "fixture-implementation-thread",
        output: request.outputValidator.parse(output),
        eventsPath: request.eventsPath,
        usage: {
          inputTokens: 1_000,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 200,
          reasoningOutputTokens: 20,
          totalTokens: 1_200,
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
  const worktrees = new TaskWorktreeService(
    seeded.paths,
    seeded.taskRepository,
    seeded.projects,
    seeded.diagnosisRepository,
    { now: () => new Date("2026-08-02T12:02:00.000Z") },
  );
  const report = await new TaskRunService(
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
  ).run(seeded.task.id);
  return { ...seeded, runReport: report };
}
