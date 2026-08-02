import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectService } from "../../src/application/projects/project-service.js";
import { TaskControlService } from "../../src/application/tasks/task-control-service.js";
import { DeterministicTaskNormalizer } from "../../src/application/tasks/deterministic-task-normalizer.js";
import { TaskService } from "../../src/application/tasks/task-service.js";
import type { TaskNormalizer } from "../../src/application/tasks/task-normalizer.js";
import { ProjectFileRepository } from "../../src/infrastructure/persistence/project-file-repository.js";
import { DiagnosisFileRepository } from "../../src/infrastructure/persistence/diagnosis-file-repository.js";
import { StatePaths } from "../../src/infrastructure/persistence/state-paths.js";
import { TaskFileRepository } from "../../src/infrastructure/persistence/task-file-repository.js";
import { VerificationFileRepository } from "../../src/infrastructure/persistence/verification-file-repository.js";
import { OrchestratorError } from "../../src/shared/errors.js";
import { createGitFixture } from "../helpers/git-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("task creation", () => {
  it("preserves feedback verbatim and keeps user suspicions unverified", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-task-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-task-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const projects = new ProjectService(new ProjectFileRepository(paths));
    await projects.add({ path: fixture, name: "demo" });
    const normalizer: TaskNormalizer = {
      normalize: () =>
        Promise.resolve({
          type: "bugfix",
          title: "Broken route",
          summary: "The route returns 500.",
          reports: [
            {
              id: "REPORT-001",
              title: "Broken route",
              route: "/bet",
              method: "POST",
              currentBehavior: "HTTP 500",
              expectedBehavior: ["Return HTTP 422 for invalid quantity"],
              payloads: [],
              observedResponses: [],
              errorMessages: ["Undefined array key position"],
              stackTraces: [],
              environment: {},
              suspectedChanges: ["Suspected cause: array indexing"],
              reproductionNotes: [],
            },
          ],
          constraints: ["Migrations must not be modified"],
          acceptanceCriteria: [
            {
              id: "AC-001",
              statement: "Return HTTP 422 for invalid quantity",
              required: true,
              source: "user",
            },
          ],
          protectedContracts: ["Public response contract remains unchanged"],
          assumptions: [
            {
              statement: "Suspected cause: array indexing",
              provenance: "user-hypothesis",
              status: "unverified",
            },
          ],
          unknowns: [],
          riskSignals: ["public-contract"],
          suggestedScope: { included: [], excluded: ["migrations"], estimatedFiles: [] },
          childTasks: [],
        }),
    };
    const repository = new TaskFileRepository(paths, undefined, {
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    const service = new TaskService(paths, repository, projects, normalizer, undefined, undefined, {
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    const feedback = "# Broken route\r\n\r\nSuspected cause: array indexing\r\n";

    const result = await service.create({ project: "demo", feedback, profile: "balanced" });
    const reloaded = await service.inspect(result.task.id);
    const status = await service.status(result.task.id);

    expect(result.task.id).toBe("BUG-2026-0001");
    expect(await readFile(result.task.originalFeedbackPath, "utf8")).toBe(feedback);
    expect(reloaded.assumptions[0]).toMatchObject({
      provenance: "user-hypothesis",
      status: "unverified",
    });
    expect(status.state.status).toBe("ready-for-diagnosis");
    expect(status.state.transitions).toHaveLength(2);
    await expect(
      repository.preserveOriginalFeedback("demo", result.task.id, "replacement"),
    ).rejects.toThrow("immutable");
  });

  it("persists, cancels, and genuinely resumes an interrupted normalization", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-normalize-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-normalize-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const repository = new TaskFileRepository(paths);
    const projects = new ProjectService(new ProjectFileRepository(paths));
    await projects.add({ path: fixture, name: "demo" });
    const deterministic = new DeterministicTaskNormalizer();
    let calls = 0;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const normalizer: TaskNormalizer = {
      normalize: (request) => {
        calls += 1;
        if (calls > 1) return deterministic.normalize(request);
        signalStarted();
        return new Promise<never>((_resolve, reject) => {
          const abort = (): void =>
            reject(
              new OrchestratorError("normalization cancelled", {
                code: "CANCELLED",
                resumable: true,
              }),
            );
          if (request.abortSignal?.aborted ?? false) abort();
          else request.abortSignal?.addEventListener("abort", abort, { once: true });
        });
      },
    };
    const service = new TaskService(paths, repository, projects, normalizer);
    const controller = new TaskControlService(
      paths,
      repository,
      projects,
      new DiagnosisFileRepository(paths),
      new VerificationFileRepository(paths),
      undefined,
      service,
    );
    const feedback = "# Interrupted bug\n\nCurrent behavior:\nBroken.\n";

    const creating = service.create({ project: "demo", feedback, profile: "balanced" });
    await started;
    const persisted = (await repository.list())[0];
    expect(persisted?.status).toBe("normalizing");
    expect(await readFile(persisted?.originalFeedbackPath ?? "", "utf8")).toBe(feedback);

    await controller.cancel(persisted?.id ?? "");
    await expect(creating).rejects.toMatchObject({
      code: "CANCELLED",
      resumable: true,
      nextCommand: `cxo task resume ${persisted?.id}`,
    });
    expect((await repository.getState(persisted?.id ?? "")).status).toBe("cancelled");

    const resumed = await controller.resume(persisted?.id ?? "");
    expect(resumed.state.status).toBe("ready-for-diagnosis");
    expect(resumed.nextCommand).toBe(`cxo task diagnose ${persisted?.id}`);
    expect(calls).toBe(2);
  });

  it("marks a non-resumable normalization integrity failure terminal", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-normalize-failed-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-normalize-failed-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const repository = new TaskFileRepository(paths);
    const projects = new ProjectService(new ProjectFileRepository(paths));
    await projects.add({ path: fixture, name: "demo" });
    const normalizer: TaskNormalizer = {
      normalize: () =>
        Promise.reject(
          new OrchestratorError("normalization identity mismatch", {
            code: "CONTEXT_INTEGRITY",
          }),
        ),
    };
    const service = new TaskService(paths, repository, projects, normalizer);
    const creating = service.create({
      project: "demo",
      feedback: "# Invalid normalization\n",
      profile: "balanced",
    });

    await expect(creating).rejects.toMatchObject({
      code: "CONTEXT_INTEGRITY",
      resumable: false,
    });
    const task = (await repository.list())[0];
    expect(task?.status).toBe("failed");
    expect((await repository.getState(task?.id ?? "")).status).toBe("failed");
  });
});
