import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectService } from "../../src/application/projects/project-service.js";
import { ProjectRefreshService } from "../../src/application/auditing/project-refresh-service.js";
import { DeterministicTaskNormalizer } from "../../src/application/tasks/deterministic-task-normalizer.js";
import { TaskService } from "../../src/application/tasks/task-service.js";
import { ProjectFileRepository } from "../../src/infrastructure/persistence/project-file-repository.js";
import { AuditArtifactRepository } from "../../src/infrastructure/persistence/audit-artifact-repository.js";
import { FileLockManager } from "../../src/infrastructure/persistence/file-lock.js";
import { StatePaths } from "../../src/infrastructure/persistence/state-paths.js";
import { TaskFileRepository } from "../../src/infrastructure/persistence/task-file-repository.js";
import { TaskStateMachine } from "../../src/orchestration/engine/state-machine.js";
import { createGitFixture, gitOutput } from "../helpers/git-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("project registration", () => {
  it("persists canonical metadata without changing the target repository", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-project-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-project-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const beforeStatus = await gitOutput(fixture, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const beforeHead = await gitOutput(fixture, ["rev-parse", "HEAD"]);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const service = new ProjectService(new ProjectFileRepository(paths));

    const project = await service.add({ path: join(fixture, "test", ".."), name: "demo" });

    expect(project.id).toBe("demo");
    expect(project.gitRoot).toBe(
      await import("node:fs/promises").then(({ realpath }) => realpath(fixture)),
    );
    expect(project.detectedStack).toMatchObject({
      languages: ["JavaScript/TypeScript"],
      frameworks: ["Express"],
    });
    expect(project.instructionFiles).toHaveLength(1);
    expect(project.skillMetadata[0]).toMatchObject({ name: "fixture-skill", source: "project" });
    expect(project.verificationPolicy.full[0]).toMatchObject({
      argv: ["node", "--test"],
      approved: true,
    });
    expect(JSON.stringify(project.remotes)).not.toMatch(/fixture-user|fixture-token|hidden/u);
    expect(await gitOutput(fixture, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
      beforeStatus,
    );
    expect(await gitOutput(fixture, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(
      JSON.parse(await readFile(join(stateHome, "projects", "demo", "project.json"), "utf8")),
    ).toMatchObject({
      schemaVersion: 1,
      id: "demo",
    });
    const projectConfig = await readFile(
      join(stateHome, "projects", "demo", "project-config.yaml"),
      "utf8",
    );
    expect(projectConfig).toContain("command:");
    expect(projectConfig).not.toContain("argv:");
  });

  it("loads explicit verification policy and preserves it across project refresh", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-project-policy-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-project-policy-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const repository = new ProjectFileRepository(paths);
    const service = new ProjectService(repository);
    await service.add({ path: fixture, name: "demo" });
    const configPath = join(stateHome, "projects", "demo", "project-config.yaml");
    const explicitConfig = `schemaVersion: 1
projectId: demo
verification:
  focused:
    - name: focused-node-test
      command: [node, --test, test/index.test.js]
      timeoutSeconds: 90
      source: user-configured
      approved: true
  full: []
  candidates: []
`;
    await writeFile(configPath, explicitConfig, "utf8");

    await expect(service.inspect("demo")).resolves.toMatchObject({
      verificationPolicy: {
        focused: [
          {
            name: "focused-node-test",
            argv: ["node", "--test", "test/index.test.js"],
            approved: true,
          },
        ],
      },
    });

    const report = await new ProjectRefreshService(
      service,
      repository,
      new AuditArtifactRepository(paths),
    ).refresh("demo");

    expect(report.project.verificationPolicy.focused[0]).toMatchObject({
      argv: ["node", "--test", "test/index.test.js"],
      approved: true,
    });
    expect(await readFile(configPath, "utf8")).toBe(explicitConfig);
  });

  it("rejects a project configuration bound to another project", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-project-config-id-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-project-config-id-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const service = new ProjectService(new ProjectFileRepository(paths));
    await service.add({ path: fixture, name: "demo" });
    await writeFile(
      join(stateHome, "projects", "demo", "project-config.yaml"),
      `schemaVersion: 1
projectId: other-project
verification:
  focused: []
  full: []
  candidates: []
`,
      "utf8",
    );

    await expect(service.inspect("demo")).rejects.toMatchObject({ code: "CONFIGURATION" });
    await expect(service.inspect("demo")).rejects.toThrow("identity mismatch");
  });

  it("removes orchestrator state without deleting the target repository", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-project-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-project-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const service = new ProjectService(new ProjectFileRepository(paths));
    await service.add({ path: fixture, name: "demo" });

    await service.remove("demo");

    await expect(readFile(join(fixture, "package.json"), "utf8")).resolves.toContain(
      "fixture-project",
    );
    await expect(service.list()).resolves.toEqual([]);
  });

  it("refuses removal while a cancelled task phase still owns its operation lock", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-project-owned-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-project-owned-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const tasks = new TaskFileRepository(paths);
    const service = new ProjectService(
      new ProjectFileRepository(paths),
      undefined,
      undefined,
      undefined,
      undefined,
      tasks,
      paths,
    );
    const project = await service.add({ path: fixture, name: "demo" });
    const created = await new TaskService(
      paths,
      tasks,
      service,
      new DeterministicTaskNormalizer(),
    ).create({
      project: project.id,
      feedback: "# Cancelled intake fixture\n",
      profile: "balanced",
    });
    const task = await tasks.get(created.task.id);
    const state = await tasks.getState(task.id);
    const timestamp = "2026-08-02T12:10:00.000Z";
    const cancelled = new TaskStateMachine().transition(state, {
      nextState: "cancelled",
      timestamp,
      reason: "fixture cancellation",
      actor: "user",
    });
    await tasks.update(
      { ...task, status: "cancelled", revision: task.revision + 1, updatedAt: timestamp },
      cancelled,
    );
    const owned = await new FileLockManager(paths.locksDirectory).acquire(
      `task-operation:${task.id}`,
    );
    try {
      await expect(service.remove(project.id)).rejects.toMatchObject({
        code: "PROJECT",
        resumable: true,
        nextCommand: `cxo task status ${task.id}`,
      });
    } finally {
      await owned.release();
    }

    await expect(service.remove(project.id)).resolves.toMatchObject({ id: project.id });
    await expect(tasks.list(project.id)).resolves.toEqual([]);
    await expect(readFile(join(fixture, "package.json"), "utf8")).resolves.toContain(
      "fixture-project",
    );
  });
});
