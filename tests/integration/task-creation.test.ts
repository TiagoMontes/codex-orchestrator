import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectService } from "../../src/application/projects/project-service.js";
import { TaskService } from "../../src/application/tasks/task-service.js";
import type { TaskNormalizer } from "../../src/application/tasks/task-normalizer.js";
import { ProjectFileRepository } from "../../src/infrastructure/persistence/project-file-repository.js";
import { StatePaths } from "../../src/infrastructure/persistence/state-paths.js";
import { TaskFileRepository } from "../../src/infrastructure/persistence/task-file-repository.js";
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
    const service = new TaskService(repository, projects, normalizer, {
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
});
