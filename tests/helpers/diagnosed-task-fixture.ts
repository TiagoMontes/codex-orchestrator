import { ConfigService } from "../../src/application/configuration/config-service.js";
import { ProjectService } from "../../src/application/projects/project-service.js";
import { DeterministicTaskNormalizer } from "../../src/application/tasks/deterministic-task-normalizer.js";
import { TaskService } from "../../src/application/tasks/task-service.js";
import type { Task } from "../../src/domain/task/task.js";
import { DiagnosisFileRepository } from "../../src/infrastructure/persistence/diagnosis-file-repository.js";
import { EvidenceFileRepository } from "../../src/infrastructure/persistence/evidence-file-repository.js";
import { ProjectFileRepository } from "../../src/infrastructure/persistence/project-file-repository.js";
import { StatePaths } from "../../src/infrastructure/persistence/state-paths.js";
import { TaskFileRepository } from "../../src/infrastructure/persistence/task-file-repository.js";
import { TaskStateMachine } from "../../src/orchestration/engine/state-machine.js";
import { gitOutput } from "./git-fixture.js";

export async function createDiagnosedTaskFixture(repositoryRoot: string, stateHome: string) {
  const paths = new StatePaths({ CODEX_ORCHESTRATOR_HOME: stateHome });
  const config = new ConfigService(paths);
  await config.initialize();
  const projects = new ProjectService(new ProjectFileRepository(paths));
  const project = await projects.add({ path: repositoryRoot, name: "demo" });
  const taskRepository = new TaskFileRepository(paths, undefined, {
    now: () => new Date("2026-08-02T12:00:00.000Z"),
  });
  const taskService = new TaskService(
    paths,
    taskRepository,
    projects,
    new DeterministicTaskNormalizer(),
    undefined,
    undefined,
    { now: () => new Date("2026-08-02T12:00:00.000Z") },
  );
  const created = await taskService.create({
    project: project.id,
    profile: "balanced",
    feedback:
      "# Fix public value bug\n\nCurrent behavior:\nThe value is wrong.\n\nExpected behavior:\n- publicValue equals 2\n\n- Preserve the public API contract.\n",
  });
  const sourceCommit = await gitOutput(repositoryRoot, ["rev-parse", "HEAD"]);
  const timestamp = "2026-08-02T12:01:00.000Z";
  const stateMachine = new TaskStateMachine();
  let state = await taskRepository.getState(created.task.id);
  state = stateMachine.transition(state, {
    nextState: "diagnosing",
    timestamp,
    reason: "fixture diagnosis started",
    actor: "system",
  });
  let task: Task = {
    ...created.task,
    status: "diagnosing",
    baseRef: project.baseRef,
    baseCommit: sourceCommit,
    revision: created.task.revision + 1,
    updatedAt: timestamp,
  };
  await taskRepository.update(task, state);
  state = stateMachine.transition(state, {
    nextState: "diagnosed",
    timestamp,
    reason: "fixture diagnosis complete",
    actor: "agent",
  });
  task = {
    ...task,
    status: "diagnosed",
    revision: task.revision + 1,
    updatedAt: timestamp,
  };
  await taskRepository.update(task, state);
  const diagnosisRepository = new DiagnosisFileRepository(paths);
  await diagnosisRepository.save(project.id, {
    schemaVersion: 1,
    taskId: task.id,
    sourceCommit,
    status: "confirmed",
    reproduction: {
      attempted: true,
      reproduced: true,
      steps: ["Inspect the exported fixture value"],
      blockers: [],
      evidenceIds: ["E1"],
    },
    confirmedFacts: [{ statement: "index.js exports publicValue as 1", evidenceIds: ["E1"] }],
    rootCauses: [
      {
        statement: "The exported fixture constant has the old value",
        confidence: "high",
        evidenceIds: ["E1"],
      },
    ],
    activeHypotheses: [],
    rejectedHypotheses: [],
    affectedFiles: [
      { path: "index.js", reason: "Defines the public value", symbols: ["publicValue"] },
      { path: "test/index.test.js", reason: "Protects the public contract", symbols: [] },
    ],
    risks: ["Preserve the publicValue export"],
    implementationPlan: [
      {
        id: "P1",
        description: "Update the value and regression assertion",
        files: ["index.js", "test/index.test.js"],
        risk: "low",
      },
    ],
    verificationPlan: [
      {
        id: "V1",
        name: "fixture tests",
        argv: ["node", "--test"],
        expectedOutcome: "all tests pass",
      },
    ],
    nextAction: "Implement in an isolated worktree",
    createdAt: timestamp,
  });
  await new EvidenceFileRepository(paths).save(project.id, task.id, [
    {
      id: "E1",
      taskId: task.id,
      kind: "file",
      status: "confirmed",
      statement: "index.js exports publicValue as 1",
      sourceCommit,
      file: "index.js",
      startLine: 1,
      endLine: 1,
      excerpt: "export const publicValue = 1;",
      observedAt: timestamp,
    },
  ]);
  return {
    paths,
    config,
    projects,
    project,
    taskRepository,
    task,
    diagnosisRepository,
    sourceCommit,
  };
}
