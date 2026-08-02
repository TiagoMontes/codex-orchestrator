import type { AppConfig } from "../../application/configuration/config-schema.js";
import type { Project } from "../../domain/project/project.js";
import type { Task } from "../../domain/task/task.js";
import type { Evidence } from "../../domain/evidence/evidence.js";
import type { ExecutionPhase } from "../../domain/execution/execution.js";
import { hashJson } from "../../shared/hashing.js";
import { OrchestratorError } from "../../shared/errors.js";
import { ContextSizer } from "./context-sizer.js";
import { EvidenceSelector } from "./evidence-selector.js";
import { contextPackSchema, type ContextPack } from "./context-pack.js";

export type ContextPackInput = {
  phase: ExecutionPhase;
  objective: string;
  task: Task;
  project: Project;
  sourceCommit: string;
  evidence: readonly Evidence[];
  relevantFiles: readonly string[];
  confirmedFacts?: readonly string[];
  confirmedCauses?: readonly string[];
  latestFailure?: string | null;
  outputSchema: Record<string, unknown>;
  worktreeHead?: string;
  diagnosis?: unknown;
  diffHash?: string;
  diffPatch?: string;
  verification?: unknown;
  selectedSkills?: ReadonlyArray<{
    name: string;
    sha256: string;
    source: "bundled" | "project" | "user";
    path: string;
    instructions: string;
    instructionsSha256: string;
  }>;
};

export class ContextPackBuilder {
  private readonly sizer: ContextSizer;
  private readonly evidenceSelector = new EvidenceSelector();

  constructor(private readonly config: AppConfig) {
    this.sizer = new ContextSizer(config.context.tokenEstimateSafetyMultiplier);
  }

  build(input: ContextPackInput): ContextPack {
    if (input.phase === "review" && input.diffHash === undefined) {
      throw new OrchestratorError("Review context requires an exact diff hash", {
        code: "CONTEXT_INTEGRITY",
      });
    }
    if (
      input.phase === "review" &&
      (input.diffPatch === undefined || input.verification === undefined)
    ) {
      throw new OrchestratorError(
        "Review context requires the exact patch and verification result",
        {
          code: "CONTEXT_INTEGRITY",
        },
      );
    }
    const withoutEstimate = {
      schemaVersion: 1 as const,
      contextPackVersion: 1 as const,
      phase: input.phase,
      objective: input.objective,
      task: {
        id: input.task.id,
        schemaVersion: input.task.schemaVersion,
        revision: input.task.revision,
        hash: hashJson(input.task),
      },
      projectId: input.project.id,
      sourceCommit: input.sourceCommit,
      ...(input.worktreeHead === undefined ? {} : { worktreeHead: input.worktreeHead }),
      ...(input.diagnosis === undefined ? {} : { diagnosisHash: hashJson(input.diagnosis) }),
      ...(input.verification === undefined
        ? {}
        : { verificationHash: hashJson(input.verification), verification: input.verification }),
      acceptanceCriteriaHash: hashJson(input.task.acceptanceCriteria),
      ...(input.diffHash === undefined ? {} : { diffHash: input.diffHash }),
      ...(input.diffPatch === undefined ? {} : { diffPatch: input.diffPatch }),
      instructionHashes: input.project.instructionFiles.map(({ relativePath, sha256 }) => ({
        path: relativePath,
        sha256,
      })),
      selectedSkills: [...(input.selectedSkills ?? [])],
      acceptanceCriteria: input.task.acceptanceCriteria,
      constraints: input.task.constraints,
      protectedContracts: input.task.protectedContracts,
      confirmedFacts: [...(input.confirmedFacts ?? [])],
      confirmedCauses: [...(input.confirmedCauses ?? [])],
      evidence: this.evidenceSelector.select(input.evidence, input.phase, {
        maxItems: this.config.context.maxEvidenceItems,
        maxExcerptCharacters: this.config.context.maxExcerptCharacters,
      }),
      relevantFiles: [...new Set(input.relevantFiles)].slice(
        0,
        this.config.context.maxRelevantFiles,
      ),
      latestFailure:
        input.latestFailure === undefined || input.latestFailure === null
          ? null
          : input.latestFailure.slice(0, this.config.context.maxExcerptCharacters),
      expectedOutputSchema: input.outputSchema,
    };
    const estimate = this.sizer.estimate(withoutEstimate);
    return contextPackSchema.parse({
      ...withoutEstimate,
      estimatedInputTokens: estimate.estimatedTokens,
      estimateSource: estimate.source,
    });
  }
}
