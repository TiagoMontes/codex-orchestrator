import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "../../src/application/configuration/config-service.js";
import { ProjectService } from "../../src/application/projects/project-service.js";
import { TaskDiagnosisService } from "../../src/application/tasks/task-diagnosis-service.js";
import { DeterministicTaskNormalizer } from "../../src/application/tasks/deterministic-task-normalizer.js";
import { TaskService } from "../../src/application/tasks/task-service.js";
import type { TaskNormalizer } from "../../src/application/tasks/task-normalizer.js";
import type {
  CodexRunRequest,
  CodexRunResult,
  CodexRuntime,
} from "../../src/infrastructure/codex/codex-runtime.js";
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
    const tasks = new TaskService(
      paths,
      taskRepository,
      projects,
      new DeterministicTaskNormalizer(),
      undefined,
      undefined,
      { now: () => new Date("2026-08-02T12:00:00.000Z") },
    );
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

  it("runs explicitly requested independent read workers before the main diagnosis", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-parallel-diagnosis-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-parallel-diagnosis-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const config = new ConfigService(paths);
    await config.initialize();
    const projects = new ProjectService(new ProjectFileRepository(paths));
    await projects.add({ path: fixture, name: "demo" });
    const taskRepository = new TaskFileRepository(paths);
    const deterministic = new DeterministicTaskNormalizer();
    const normalizer: TaskNormalizer = {
      normalize: async (request) => {
        const draft = await deterministic.normalize(request);
        const first = draft.reports[0]!;
        return {
          ...draft,
          reports: [
            { ...first, id: "REPORT-001", title: "Inspect implementation module" },
            {
              ...first,
              id: "REPORT-002",
              title: "Inspect regression tests",
              route: "/tests",
            },
          ],
          suggestedScope: {
            ...draft.suggestedScope,
            estimatedFiles: ["index.js", "test/index.test.js"],
          },
        };
      },
    };
    const created = await new TaskService(paths, taskRepository, projects, normalizer).create({
      project: "demo",
      feedback: "# Inspect two independent modules\n",
      profile: "balanced",
    });
    const sourceCommit = await gitOutput(fixture, ["rev-parse", "HEAD"]);
    let activeReaders = 0;
    let maximumReaders = 0;
    const roles: string[] = [];
    let diagnosisPrompt = "";
    const runtime: CodexRuntime = {
      runStructured: async (request) => {
        roles.push(request.role);
        if (request.role === "read-worker") {
          activeReaders += 1;
          maximumReaders = Math.max(maximumReaders, activeReaders);
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          activeReaders -= 1;
          const workerId = /^# Read-only workstream (.+)$/mu.exec(request.prompt)?.[1] ?? "missing";
          const file = workerId === "report-1" ? "index.js" : "test/index.test.js";
          const output = {
            schemaVersion: 1,
            workerId,
            taskId: created.task.id,
            sourceCommit,
            summary: `Inspected ${file}`,
            evidence: [
              {
                id: `untrusted-${workerId}`,
                taskId: created.task.id,
                kind: "file",
                status: "confirmed",
                statement: `${file} belongs to its independent workstream`,
                sourceCommit,
                file,
                startLine: 1,
                endLine: 1,
                observedAt: "2026-08-02T12:01:00.000Z",
              },
            ],
          };
          return agentResult(request, output, `thread-${workerId}`);
        }
        diagnosisPrompt = request.prompt;
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
              blockers: [],
              evidenceIds: [],
            },
            confirmedFacts: [
              { statement: "The implementation export is present", evidenceIds: ["D1"] },
            ],
            rootCauses: [
              {
                statement: "The task requires coordinated inspection only",
                confidence: "medium",
                evidenceIds: ["D1"],
              },
            ],
            activeHypotheses: [],
            rejectedHypotheses: [],
            affectedFiles: [
              { path: "index.js", reason: "Public implementation", symbols: ["publicValue"] },
            ],
            risks: [],
            implementationPlan: [
              { id: "P1", description: "Preserve both modules", files: ["index.js"], risk: "low" },
            ],
            verificationPlan: [
              {
                id: "V1",
                name: "node tests",
                argv: ["node", "--test"],
                expectedOutcome: "tests pass",
              },
            ],
            nextAction: "Prepare the implementation worktree",
            createdAt: "2026-08-02T12:01:00.000Z",
          },
          evidence: [
            {
              id: "D1",
              taskId: created.task.id,
              kind: "file",
              status: "confirmed",
              statement: "index.js exports publicValue",
              sourceCommit,
              file: "index.js",
              startLine: 1,
              endLine: 1,
              observedAt: "2026-08-02T12:01:00.000Z",
            },
          ],
        };
        return agentResult(request, output, "diagnosis-main-thread");
      },
    };
    const usage = new UsageFileRepository(paths);
    const executions = new ExecutionFileRepository(paths);
    const diagnosis = new TaskDiagnosisService(
      config,
      paths,
      taskRepository,
      projects,
      runtime,
      usage,
      new DiagnosisFileRepository(paths),
      new EvidenceFileRepository(paths),
      executions,
      new DecisionFileRepository(paths),
    );

    const report = await diagnosis.diagnose(created.task.id, { parallelReaders: 2 });

    expect(maximumReaders).toBe(2);
    expect(roles.filter((role) => role === "read-worker")).toHaveLength(2);
    expect(roles.at(-1)).toBe("diagnostician");
    expect(diagnosisPrompt).toContain("PW-report-1");
    expect(report.evidence).toHaveLength(3);
    expect((await usage.read("demo", created.task.id)).totalCalls).toBe(3);
    expect(
      (await executions.list("demo", created.task.id)).filter(
        (attempt) => attempt.phase === "exploration",
      ),
    ).toHaveLength(2);
  });
});

function agentResult<T>(
  request: CodexRunRequest<T>,
  output: unknown,
  threadId: string,
): CodexRunResult<T> {
  return {
    threadId,
    output: request.outputValidator.parse(output),
    eventsPath: request.eventsPath,
    usage: {
      inputTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 50,
      reasoningOutputTokens: 10,
      totalTokens: 150,
      source: "actual" as const,
    },
    finalResponse: JSON.stringify(output),
    runtimeAttempts: 1,
    compatibility: {
      sdkVersion: "0.146.0",
      requestedReasoning: request.reasoningPreset,
      mappedReasoning:
        request.reasoningPreset === "deepest" ? ("xhigh" as const) : request.reasoningPreset,
      fallbackApplied: false,
      missingUsageFields: [],
    },
  };
}
