import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigService } from "../../src/application/configuration/config-service.js";
import { ProjectService } from "../../src/application/projects/project-service.js";
import { DeterministicTaskNormalizer } from "../../src/application/tasks/deterministic-task-normalizer.js";
import { TaskService } from "../../src/application/tasks/task-service.js";
import { TaskWorktreeService } from "../../src/application/tasks/task-worktree-service.js";
import { DiagnosisFileRepository } from "../../src/infrastructure/persistence/diagnosis-file-repository.js";
import { ProjectFileRepository } from "../../src/infrastructure/persistence/project-file-repository.js";
import { StatePaths } from "../../src/infrastructure/persistence/state-paths.js";
import { TaskFileRepository } from "../../src/infrastructure/persistence/task-file-repository.js";
import { DiffService } from "../../src/infrastructure/git/diff-service.js";
import { TaskStateMachine } from "../../src/orchestration/engine/state-machine.js";
import { createGitFixture, gitOutput } from "../helpers/git-fixture.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (path) => rm(path, { recursive: true })),
  );
});

describe("task worktrees", () => {
  it("isolates writes, captures a hashed binary-aware diff, and cleans up explicitly", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "cxo-worktree-fixture-"));
    const stateHome = await mkdtemp(join(tmpdir(), "cxo-worktree-state-"));
    temporaryDirectories.push(fixture, stateHome);
    await createGitFixture(fixture);
    const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
    const config = new ConfigService(paths);
    await config.initialize();
    const projects = new ProjectService(new ProjectFileRepository(paths));
    const project = await projects.add({ path: fixture, name: "demo" });
    const taskRepository = new TaskFileRepository(paths, undefined, {
      now: () => new Date("2026-08-02T12:00:00.000Z"),
    });
    const taskService = new TaskService(
      taskRepository,
      projects,
      new DeterministicTaskNormalizer(),
      { now: () => new Date("2026-08-02T12:00:00.000Z") },
    );
    const created = await taskService.create({
      project: project.id,
      profile: "balanced",
      feedback:
        "# Fix public value\n\nCurrent behavior:\nThe value is wrong.\n\nExpected behavior:\n- value is correct\n",
    });
    const sourceCommit = await gitOutput(fixture, ["rev-parse", "HEAD"]);
    const diagnosisRepository = new DiagnosisFileRepository(paths);
    const timestamp = "2026-08-02T12:01:00.000Z";
    const stateMachine = new TaskStateMachine();
    let state = await taskRepository.getState(created.task.id);
    state = stateMachine.transition(state, {
      nextState: "diagnosing",
      timestamp,
      reason: "fixture diagnosis started",
      actor: "system",
    });
    state = stateMachine.transition(state, {
      nextState: "diagnosed",
      timestamp,
      reason: "fixture diagnosis complete",
      actor: "agent",
    });
    await taskRepository.update(
      {
        ...created.task,
        status: "diagnosed",
        baseRef: project.baseRef,
        baseCommit: sourceCommit,
        revision: created.task.revision + 1,
        updatedAt: timestamp,
      },
      state,
    );
    await diagnosisRepository.save(project.id, {
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
      confirmedFacts: [{ statement: "index.js defines the value", evidenceIds: ["E1"] }],
      rootCauses: [
        {
          statement: "The fixture value needs correction",
          confidence: "high",
          evidenceIds: ["E1"],
        },
      ],
      activeHypotheses: [],
      rejectedHypotheses: [],
      affectedFiles: [{ path: "index.js", reason: "defines value", symbols: ["publicValue"] }],
      risks: [],
      implementationPlan: [
        { id: "P1", description: "Change value", files: ["index.js"], risk: "low" },
      ],
      verificationPlan: [
        {
          id: "V1",
          name: "tests",
          argv: ["node", "--test"],
          expectedOutcome: "pass",
        },
      ],
      nextAction: "prepare worktree",
      createdAt: timestamp,
    });
    const beforeHead = await gitOutput(fixture, ["rev-parse", "HEAD"]);
    const beforeStatus = await gitOutput(fixture, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]);
    const worktrees = new TaskWorktreeService(
      paths,
      taskRepository,
      projects,
      diagnosisRepository,
      { now: () => new Date("2026-08-02T12:02:00.000Z") },
    );

    const prepared = await worktrees.prepare(created.task.id);

    expect(prepared.worktree).toMatchObject({
      branch: `codex/${created.task.id}-fix-public-value`,
      baseCommit: sourceCommit,
      headCommit: sourceCommit,
      reused: false,
    });
    expect(await gitOutput(prepared.worktree.path, ["status", "--porcelain=v1"])).toBe("");
    expect(await gitOutput(fixture, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await gitOutput(fixture, ["status", "--porcelain=v1"])).toBe(beforeStatus);

    await writeFile(
      join(prepared.worktree.path, "index.js"),
      "export const publicValue = 2;\n",
      "utf8",
    );
    await writeFile(join(prepared.worktree.path, "binary.dat"), Buffer.from([0, 1, 2, 3]));
    const diffs = new DiffService(paths, undefined, undefined, undefined, {
      now: () => new Date("2026-08-02T12:03:00.000Z"),
    });
    const diff = await diffs.capture({
      projectId: project.id,
      taskId: created.task.id,
      worktreePath: prepared.worktree.path,
      sourceCommit,
      baseCommit: sourceCommit,
    });

    expect(diff.changedFiles).toEqual(["binary.dat", "index.js"]);
    expect(diff.binaryFiles).toEqual(["binary.dat"]);
    expect(diff.diffHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(await readFile(diff.patchPath, "utf8")).toContain("publicValue = 2");
    await writeFile(
      join(prepared.worktree.path, "index.js"),
      "export const publicValue = 3;\n",
      "utf8",
    );
    await expect(diffs.assertCurrent(diff, prepared.worktree.path)).rejects.toMatchObject({
      code: "CONTEXT_INTEGRITY",
    });
    await expect(worktrees.cleanup(created.task.id)).rejects.toMatchObject({
      code: "TASK_STATE",
    });

    const cleanup = await worktrees.cleanup(created.task.id, {
      force: true,
      deleteBranch: true,
    });

    expect(cleanup).toMatchObject({ branchDeleted: true });
    await expect(access(prepared.worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(gitOutput(fixture, ["rev-parse", cleanup.branch])).rejects.toBeDefined();
    expect(await gitOutput(fixture, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(await gitOutput(fixture, ["status", "--porcelain=v1"])).toBe(beforeStatus);
    expect((await taskRepository.get(created.task.id)).worktree).toBeUndefined();
    expect(
      await readFile(
        join(stateHome, "projects", "demo", "tasks", created.task.id, "runs", "git.jsonl"),
        "utf8",
      ),
    ).toContain('"exitCode":0');
  });
});
