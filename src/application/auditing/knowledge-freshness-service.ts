import type { KnowledgeGeneration } from "../../infrastructure/persistence/audit-artifact-repository.js";
import { OrchestratorError } from "../../shared/errors.js";

export type KnowledgeFreshnessAssessment = {
  stale: boolean;
  usable: boolean;
  reason?: string;
  validatedThroughCommit?: string;
};

export class KnowledgeFreshnessService {
  assess(input: {
    generation: KnowledgeGeneration;
    currentHeadCommit: string;
    instructionHashes: Array<{ path: string; sha256: string }>;
    changedFiles: readonly string[];
  }): KnowledgeFreshnessAssessment {
    const instructionsChanged =
      JSON.stringify(normalizeHashes(input.generation.manifest.instructionHashes)) !==
      JSON.stringify(normalizeHashes(input.instructionHashes));
    const headChanged = input.generation.manifest.sourceCommit !== input.currentHeadCommit;
    if (!instructionsChanged && !headChanged) return { stale: false, usable: true };
    if (instructionsChanged) {
      return {
        stale: true,
        usable: false,
        reason: "Repository instruction files changed after the audit",
      };
    }
    const evidenceFiles = new Set(
      Object.values(input.generation.artifacts).flatMap((artifact) =>
        artifact.evidenceReferences.flatMap((evidence) =>
          evidence.file === undefined ? [] : [evidence.file],
        ),
      ),
    );
    const changedEvidence = input.changedFiles.filter((path) => evidenceFiles.has(path));
    if (changedEvidence.length > 0) {
      return {
        stale: true,
        usable: false,
        reason: `Evidence changed after the audit: ${changedEvidence.sort().join(", ")}`,
      };
    }
    return {
      stale: true,
      usable: true,
      reason: "HEAD moved, but audited evidence files are unchanged",
      validatedThroughCommit: input.currentHeadCommit,
    };
  }

  assertUsable(generation: KnowledgeGeneration, currentHeadCommit: string): KnowledgeGeneration {
    if (
      generation.manifest.stale &&
      generation.manifest.validatedThroughCommit !== currentHeadCommit
    ) {
      throw new OrchestratorError(
        "Repository knowledge is stale; run `cxo project refresh` or `cxo project audit`",
        { code: "CONTEXT_INTEGRITY" },
      );
    }
    return generation;
  }
}

function normalizeHashes(items: Array<{ path: string; sha256: string }>) {
  return [...items].sort((left, right) => left.path.localeCompare(right.path));
}
