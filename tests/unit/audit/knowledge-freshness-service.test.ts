import { describe, expect, it } from "vitest";
import { KnowledgeFreshnessService } from "../../../src/application/auditing/knowledge-freshness-service.js";
import type { KnowledgeGeneration } from "../../../src/infrastructure/persistence/audit-artifact-repository.js";

describe("KnowledgeFreshnessService", () => {
  const service = new KnowledgeFreshnessService();

  it("keeps same-commit knowledge fresh", () => {
    expect(
      service.assess({
        generation: generation(),
        currentHeadCommit: "source",
        instructionHashes: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
        changedFiles: [],
      }),
    ).toEqual({ stale: false, usable: true });
  });

  it("revalidates unrelated commits but rejects changed evidence", () => {
    expect(
      service.assess({
        generation: generation(),
        currentHeadCommit: "next",
        instructionHashes: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
        changedFiles: ["README.md"],
      }),
    ).toMatchObject({ stale: true, usable: true, validatedThroughCommit: "next" });
    expect(
      service.assess({
        generation: generation(),
        currentHeadCommit: "next",
        instructionHashes: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
        changedFiles: ["index.js"],
      }),
    ).toMatchObject({ stale: true, usable: false });
  });

  it("rejects changed repository instructions", () => {
    expect(
      service.assess({
        generation: generation(),
        currentHeadCommit: "source",
        instructionHashes: [{ path: "AGENTS.md", sha256: "b".repeat(64) }],
        changedFiles: [],
      }),
    ).toMatchObject({ stale: true, usable: false });
  });
});

function generation(): KnowledgeGeneration {
  const evidence = [
    {
      id: "K1",
      kind: "file" as const,
      status: "confirmed" as const,
      statement: "The exported value is defined",
      sourceCommit: "source",
      file: "index.js",
    },
  ];
  const common = {
    schemaVersion: 1 as const,
    auditRunId: "b82eaed1-5f37-489d-bd57-2f830a7e745c",
    projectId: "demo",
    sourceCommit: "source",
    generatedAt: "2026-08-02T12:00:00.000Z",
    modelDecision: {
      schemaVersion: 1 as const,
      phase: "audit" as const,
      profile: "balanced" as const,
      modelAlias: "efficient" as const,
      model: "model",
      reasoning: "medium" as const,
      routingSignals: [],
      reason: "test",
      estimatedCallTokens: 1,
      remainingBudgetTokens: 2,
      manualOverrides: {},
    },
    usage: {
      inputTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1,
      reasoningOutputTokens: 0,
      totalTokens: 2,
      source: "actual" as const,
    },
    evidenceReferences: evidence,
    stale: false,
  };
  return {
    artifacts: {
      repositoryMap: {
        ...common,
        artifactType: "repository-map",
        payload: { summary: "map", modules: [], entryPoints: [], unknowns: [] },
      },
      architecture: {
        ...common,
        artifactType: "architecture",
        payload: { summary: "architecture", components: [], relationships: [], unknowns: [] },
      },
      businessRules: {
        ...common,
        artifactType: "business-rules",
        payload: { rules: [], unknowns: [] },
      },
      verification: {
        ...common,
        artifactType: "verification",
        payload: { summary: "verification", strategies: [], unknowns: [] },
      },
      risks: {
        ...common,
        artifactType: "risks",
        payload: { summary: "risks", risks: [], unknowns: [] },
      },
    },
    manifest: {
      schemaVersion: 1,
      auditRunId: common.auditRunId,
      projectId: "demo",
      sourceCommit: "source",
      currentHeadCommit: "source",
      instructionHashes: [{ path: "AGENTS.md", sha256: "a".repeat(64) }],
      artifactHashes: {
        repositoryMap: "1".repeat(64),
        architecture: "2".repeat(64),
        businessRules: "3".repeat(64),
        verification: "4".repeat(64),
        risks: "5".repeat(64),
      },
      stale: false,
      updatedAt: common.generatedAt,
    },
  };
}
