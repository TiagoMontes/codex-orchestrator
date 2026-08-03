import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../../src/application/configuration/default-config.js";
import type { Project } from "../../../src/domain/project/project.js";
import type { Task } from "../../../src/domain/task/task.js";
import { ContextPackBuilder } from "../../../src/orchestration/context/context-pack-builder.js";
import { ContextIntegrityValidator } from "../../../src/orchestration/context/context-integrity-validator.js";

const timestamp = "2026-08-02T12:00:00.000Z";
const project: Project = {
  schemaVersion: 1,
  id: "demo",
  name: "demo",
  repositoryPath: "/tmp/demo",
  gitRoot: "/tmp/demo",
  baseRef: "main",
  registeredHeadCommit: "a".repeat(40),
  remotes: [],
  detectedStack: { languages: [], packageManagers: [], frameworks: [], manifests: [] },
  instructionFiles: [
    { path: "/tmp/demo/AGENTS.md", relativePath: "AGENTS.md", sha256: "b".repeat(64) },
  ],
  skillMetadata: [],
  environmentPolicy: { allowlist: [], secretExceptions: [] },
  verificationPolicy: { focused: [], full: [], candidates: [] },
  createdAt: timestamp,
  updatedAt: timestamp,
};
const task: Task = {
  schemaVersion: 1,
  revision: 1,
  id: "BUG-2026-0001",
  projectId: "demo",
  childTaskIds: [],
  type: "bugfix",
  title: "Bug",
  summary: "Fix bug",
  originalFeedbackPath: "/tmp/state/original.md",
  originalFeedbackSha256: "a".repeat(64),
  profile: "balanced",
  risk: "medium",
  riskSignals: [],
  status: "diagnosed",
  reports: [
    {
      id: "R1",
      title: "Bug",
      currentBehavior: "broken",
      expectedBehavior: ["works"],
      payloads: [],
      observedResponses: [],
      errorMessages: [],
      stackTraces: [],
      environment: {},
      suspectedChanges: [],
      reproductionNotes: [],
    },
  ],
  constraints: ["Do not change API"],
  acceptanceCriteria: [{ id: "AC-1", statement: "works", required: true, source: "user" }],
  protectedContracts: ["API"],
  assumptions: [],
  unknowns: [],
  requestedScope: { included: [], excluded: [], estimatedFiles: [] },
  createdAt: timestamp,
  updatedAt: timestamp,
};

describe("ContextPackBuilder and integrity", () => {
  it("selects bounded phase data without logs or conversation history", () => {
    const builder = new ContextPackBuilder({
      ...DEFAULT_CONFIG,
      context: { ...DEFAULT_CONFIG.context, maxEvidenceItems: 1, maxRelevantFiles: 1 },
    });
    const pack = builder.build({
      phase: "diagnosis",
      objective: "Confirm the bug",
      task,
      project,
      sourceCommit: "a".repeat(40),
      evidence: [
        {
          id: "E1",
          taskId: task.id,
          kind: "file",
          status: "confirmed",
          statement: "handler is here",
          sourceCommit: "a".repeat(40),
          excerpt: "x".repeat(5_000),
          observedAt: timestamp,
        },
        {
          id: "E2",
          taskId: task.id,
          kind: "log",
          status: "unverified",
          statement: "noise",
          sourceCommit: "a".repeat(40),
          observedAt: timestamp,
        },
      ],
      relevantFiles: ["src/a.ts", "src/b.ts"],
      outputSchema: { type: "object" },
    });

    expect(pack.evidence).toHaveLength(1);
    expect(pack.evidence[0]?.excerpt).toHaveLength(DEFAULT_CONFIG.context.maxExcerptCharacters);
    expect(pack.relevantFiles).toEqual(["src/a.ts"]);
    expect(pack.taskBrief).toMatchObject({
      title: "Bug",
      summary: "Fix bug",
      reports: [{ currentBehavior: "broken", expectedBehavior: ["works"] }],
    });
    expect(pack).not.toHaveProperty("logs");
    expect(pack).not.toHaveProperty("conversationHistory");
    expect(() =>
      new ContextIntegrityValidator().assertValid(pack, {
        task,
        project,
        sourceCommit: "a".repeat(40),
      }),
    ).not.toThrow();
  });

  it("detects a stale source commit", () => {
    const pack = new ContextPackBuilder(DEFAULT_CONFIG).build({
      phase: "diagnosis",
      objective: "Confirm the bug",
      task,
      project,
      sourceCommit: "a".repeat(40),
      evidence: [],
      relevantFiles: [],
      outputSchema: { type: "object" },
    });

    expect(() =>
      new ContextIntegrityValidator().assertValid(pack, {
        task,
        project,
        sourceCommit: "c".repeat(40),
      }),
    ).toThrow("source commit");
  });
});
