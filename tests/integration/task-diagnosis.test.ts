import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "../../src/application/configuration/config-service.js";
import { ProjectService } from "../../src/application/projects/project-service.js";
import { TaskDiagnosisService } from "../../src/application/tasks/task-diagnosis-service.js";
import { DeterministicTaskNormalizer } from "../../src/application/tasks/deterministic-task-normalizer.js";
import { TaskService } from "../../src/application/tasks/task-service.js";
import type { CodexRuntime } from "../../src/infrastructure/codex/codex-runtime.js";
import { DecisionFileRepository } from "../../src/infrastructure/persistence/decision-file-repository.js";
import { DiagnosisFileRepository } from "../../src/infrastructure/persistence/diagnosis-file-repository.js";
import { EvidenceFileRepository } from "../../src/infrastructure/persistence/evidence-file-repository.js";
import { ExecutionFileRepository } from "../../src/infrastructure/persistence/execution-file-repository.js";
import { ProjectFileRepository } from "../../src/infrastructure/persistence/project-file-repository.js";
import { StatePaths } from "../../src/infrastructure/persistence/state-paths.js";
import { TaskFileRepository } from "../../src/infrastructure/persistence/task-file-repository.js";
import { UsageFileRepository } from "../../src/infrastructure/persistence/usage-file-repository.js";
import { createGitFixture, gitOutput } from "../helpers/git-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("task diagnosis", () => {
  it("persists an evidenced read-only diagnosis without changing the primary checkout", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-diagnosis-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-diagnosis-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const config = new ConfigService(paths);
    await config.initialize();
    const projects = new ProjectService(new ProjectFileRepository(paths));
    await projects.add({ path: fixture, name: "demo" });
    const taskRepository = new TaskFileRepository(paths, undefined, {
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    const tasks = new TaskService(taskRepository, projects, new DeterministicTaskNormalizer(), {
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    const created = await tasks.create({
      project: "demo",
      feedback:
        "# Broken public value\n\nCurrent behavior:\nThe value is wrong.\n\nExpected behavior:\n- value is correct\n",
      profile: "balanced",
    });
    const sourceCommit = await gitOutput(fixture, ["rev-parse", "HEAD"]);
    const beforeStatus = await gitOutput(fixture, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    let capturedSandbox: string | undefined;
    const runtime: CodexRuntime = {
      runStructured: (request) => {
        capturedSandbox = request.sandboxMode;
        const output = {
          diagnosis: {
            schemaVersion: 1,
            taskId: created.task.id,
            sourceCommit,
            status: "confirmed",
            reproduction: {
              attempted: false,
              reproduced: false,
              steps: [],
              blockers: ["No configured reproduction command was needed for static diagnosis"],
              evidenceIds: [],
            },
            confirmedFacts: [
              { statement: "The public value is defined in index.js", evidenceIds: ["E1"] },
            ],
            rootCauses: [
              {
                statement: "The exported constant has the wrong value",
                confidence: "high",
                evidenceIds: ["E1"],
              },
            ],
            activeHypotheses: [],
            rejectedHypotheses: [],
            affectedFiles: [
              { path: "index.js", reason: "Defines the value", symbols: ["publicValue"] },
            ],
            risks: ["Preserve the exported symbol"],
            implementationPlan: [
              { id: "P1", description: "Correct the constant", files: ["index.js"], risk: "low" },
            ],
            verificationPlan: [
              {
                id: "V1",
                name: "node tests",
                argv: ["node", "--test"],
                expectedOutcome: "tests pass",
              },
            ],
            nextAction: "Create the isolated implementation worktree",
            createdAt: "2026-08-02T12:01:00.000Z",
          },
          evidence: [
            {
              id: "E1",
              taskId: created.task.id,
              kind: "file",
              status: "confirmed",
              statement: "index.js defines publicValue",
              sourceCommit,
              file: "index.js",
              startLine: 1,
              endLine: 1,
              observedAt: "2026-08-02T12:01:00.000Z",
            },
          ],
        };
        return Promise.resolve({
          threadId: "diagnosis-thread",
          output: request.outputValidator.parse(output),
          eventsPath: request.eventsPath,
          usage: {
            inputTokens: 1_000,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 500,
            reasoningOutputTokens: 100,
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
        });
      },
    };
    const diagnosis = new TaskDiagnosisService(
      config,
      paths,
      taskRepository,
      projects,
      runtime,
      new UsageFileRepository(paths),
      new DiagnosisFileRepository(paths),
      new EvidenceFileRepository(paths),
      new ExecutionFileRepository(paths),
      new DecisionFileRepository(paths),
      { now: () => new Date("2026-08-02T12:01:00.000Z") },
    );

    const report = await diagnosis.diagnose(created.task.id);

    expect(capturedSandbox).toBe("read-only");
    expect(report.diagnosis).toMatchObject({ status: "confirmed", sourceCommit });
    expect(report.evidence[0]?.file).toBe("index.js");
    expect(report.evidence[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.task.status).toBe("diagnosed");
    expect(report.modelDecision).toMatchObject({ model: "gpt-5.6-terra", reasoning: "medium" });
    expect(await gitOutput(fixture, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
      beforeStatus,
    );
    expect(await gitOutput(fixture, ["rev-parse", "HEAD"])).toBe(sourceCommit);
    expect(
      JSON.parse(
        await readFile(
          join(stateHome, "projects", "demo", "tasks", created.task.id, "diagnosis.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      taskId: created.task.id,
      sourceCommit,
    });
    expect((await new UsageFileRepository(paths).read("demo", created.task.id)).totalCalls).toBe(1);
  });
});
