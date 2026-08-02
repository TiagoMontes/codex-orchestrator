import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/application/configuration/config-schema.js";
import type {
  CodexRunRequest,
  CodexRunResult,
  CodexRuntime,
} from "../../src/infrastructure/codex/codex-runtime.js";
import { DecisionFileRepository } from "../../src/infrastructure/persistence/decision-file-repository.js";
import { EvidenceFileRepository } from "../../src/infrastructure/persistence/evidence-file-repository.js";
import { ExecutionFileRepository } from "../../src/infrastructure/persistence/execution-file-repository.js";
import { UsageFileRepository } from "../../src/infrastructure/persistence/usage-file-repository.js";
import { ParallelReadCoordinator } from "../../src/orchestration/parallel/parallel-read-coordinator.js";
import type { ReadWorkstream } from "../../src/orchestration/parallel/workstream-partitioner.js";
import { createDiagnosedTaskFixture } from "../helpers/diagnosed-task-fixture.js";
import { createGitFixture, gitOutput } from "../helpers/git-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

const workstreams: ReadWorkstream[] = [
  {
    id: "implementation-module",
    objective: "Inspect the exported public value",
    scopeKeys: ["index.js"],
    relevantFiles: ["index.js"],
    depth: 1,
  },
  {
    id: "test-module",
    objective: "Inspect the public value contract test",
    scopeKeys: ["test/index.test.js"],
    relevantFiles: ["test/index.test.js"],
    depth: 1,
  },
];

describe("parallel read coordination", () => {
  it("runs disjoint workers concurrently under one parent budget without repository writes", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "cxo-parallel-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-parallel-state-"));
    temporaryDirectories.push(repositoryRoot, stateHome);
    await createGitFixture(repositoryRoot);
    const fixture = await createDiagnosedTaskFixture(repositoryRoot, stateHome);
    const config = await fixture.config.load();
    let active = 0;
    let maximumActive = 0;
    const requests: Array<CodexRunRequest<unknown>> = [];
    const runtime: CodexRuntime = {
      async runStructured<T>(request: CodexRunRequest<T>): Promise<CodexRunResult<T>> {
        requests.push(request);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        active -= 1;
        const workerId = /^# Read-only workstream (.+)$/mu.exec(request.prompt)?.[1];
        if (workerId === undefined) throw new Error("worker identity missing from prompt");
        const file = workerId === "implementation-module" ? "index.js" : "test/index.test.js";
        const output = request.outputValidator.parse({
          schemaVersion: 1,
          workerId,
          taskId: fixture.task.id,
          sourceCommit: fixture.sourceCommit,
          summary: `Confirmed ${file}`,
          evidence: [
            {
              id: `untrusted-${workerId}`,
              taskId: fixture.task.id,
              kind: "file",
              status: "confirmed",
              statement: `${file} is in the declared scope`,
              sourceCommit: fixture.sourceCommit,
              file,
              startLine: 1,
              endLine: 1,
              observedAt: "2026-08-02T12:02:00.000Z",
            },
          ],
        });
        return {
          threadId: `thread-${workerId}`,
          output,
          eventsPath: request.eventsPath,
          usage: {
            inputTokens: 100,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 50,
            reasoningOutputTokens: 10,
            totalTokens: 150,
            source: "actual",
          },
          finalResponse: "raw worker chatter must not be consolidated",
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
    const usage = new UsageFileRepository(fixture.paths);
    const coordinator = createCoordinator(config, fixture, runtime, usage);
    const beforeStatus = await gitOutput(repositoryRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);

    const report = await coordinator.run({
      task: fixture.task,
      project: fixture.project,
      sourceCommit: fixture.sourceCommit,
      profile: "balanced",
      workstreams,
    });

    expect(maximumActive).toBe(2);
    expect(requests).toHaveLength(2);
    expect(
      requests.every(
        (request) =>
          request.role === "read-worker" &&
          request.sandboxMode === "read-only" &&
          request.networkAccessEnabled === false &&
          request.resumeThreadId === undefined,
      ),
    ).toBe(true);
    expect(new Set(requests.map((request) => request.eventsPath)).size).toBe(2);
    expect(report.result.workerIds).toEqual(["implementation-module", "test-module"]);
    expect(report.result.evidence).toHaveLength(2);
    expect(JSON.stringify(report.result)).not.toContain("raw worker chatter");
    expect(report.usage.totalCalls).toBe(2);
    expect(report.usage.reservations).toEqual([]);
    expect(report.usage.entries.map((entry) => entry.workerId).sort()).toEqual([
      "implementation-module",
      "test-module",
    ]);
    expect(await gitOutput(repositoryRoot, ["rev-parse", "HEAD"])).toBe(fixture.sourceCommit);
    expect(
      await gitOutput(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ).toBe(beforeStatus);
  });

  it("releases a partially admitted batch and starts no worker when the parent call budget is low", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "cxo-parallel-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-parallel-state-"));
    temporaryDirectories.push(repositoryRoot, stateHome);
    await createGitFixture(repositoryRoot);
    const fixture = await createDiagnosedTaskFixture(repositoryRoot, stateHome);
    const loaded = await fixture.config.load();
    const config: AppConfig = {
      ...loaded,
      profiles: {
        ...loaded.profiles,
        balanced: { ...loaded.profiles.balanced, maxAgentCalls: 3 },
      },
    };
    let runtimeCalls = 0;
    const runtime: CodexRuntime = {
      runStructured: () => {
        runtimeCalls += 1;
        throw new Error("runtime must not start");
      },
    };
    const usage = new UsageFileRepository(fixture.paths);
    const coordinator = createCoordinator(config, fixture, runtime, usage);

    await expect(
      coordinator.run({
        task: fixture.task,
        project: fixture.project,
        sourceCommit: fixture.sourceCommit,
        profile: "balanced",
        workstreams,
      }),
    ).rejects.toMatchObject({ code: "BUDGET" });

    expect(runtimeCalls).toBe(0);
    expect((await usage.read(fixture.project.id, fixture.task.id)).reservations).toEqual([]);
  });

  it("blocks out-of-scope worker evidence and leaves no reservation", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "cxo-parallel-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-parallel-state-"));
    temporaryDirectories.push(repositoryRoot, stateHome);
    await createGitFixture(repositoryRoot);
    const fixture = await createDiagnosedTaskFixture(repositoryRoot, stateHome);
    const config = await fixture.config.load();
    const runtime: CodexRuntime = {
      runStructured<T>(request: CodexRunRequest<T>): Promise<CodexRunResult<T>> {
        const workerId = /^# Read-only workstream (.+)$/mu.exec(request.prompt)?.[1] ?? "missing";
        const output = request.outputValidator.parse({
          schemaVersion: 1,
          workerId,
          taskId: fixture.task.id,
          sourceCommit: fixture.sourceCommit,
          summary: "Attempted cross-scope evidence",
          evidence: [
            {
              id: "cross-scope",
              taskId: fixture.task.id,
              kind: "file",
              status: "confirmed",
              statement: "Cross-scope claim",
              sourceCommit: fixture.sourceCommit,
              file: workerId === "implementation-module" ? "test/index.test.js" : "index.js",
              observedAt: "2026-08-02T12:02:00.000Z",
            },
          ],
        });
        return Promise.resolve({
          threadId: `thread-${workerId}`,
          output,
          eventsPath: request.eventsPath,
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            outputTokens: 10,
            reasoningOutputTokens: 0,
            totalTokens: 20,
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
    const usage = new UsageFileRepository(fixture.paths);

    await expect(
      createCoordinator(config, fixture, runtime, usage).run({
        task: fixture.task,
        project: fixture.project,
        sourceCommit: fixture.sourceCommit,
        profile: "balanced",
        workstreams,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_INTEGRITY" });
    expect((await usage.read(fixture.project.id, fixture.task.id)).reservations).toEqual([]);
  });
});

function createCoordinator(
  config: AppConfig,
  fixture: Awaited<ReturnType<typeof createDiagnosedTaskFixture>>,
  runtime: CodexRuntime,
  usage: UsageFileRepository,
): ParallelReadCoordinator {
  return new ParallelReadCoordinator(
    config,
    fixture.paths,
    runtime,
    usage,
    new EvidenceFileRepository(fixture.paths),
    new ExecutionFileRepository(fixture.paths),
    new DecisionFileRepository(fixture.paths),
    { now: () => new Date("2026-08-02T12:02:00.000Z") },
  );
}
