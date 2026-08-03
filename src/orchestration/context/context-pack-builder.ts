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
import { ContextCompactor } from "./context-compactor.js";
import { ThreadRotationPolicy } from "./thread-rotation-policy.js";

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
    const compactedState = new ContextCompactor().compact({
      acceptanceCriteria: input.task.acceptanceCriteria.map((item) => item.statement),
      constraints: input.task.constraints,
      protectedContracts: input.task.protectedContracts,
      humanDecisions: [],
      confirmedFacts: input.confirmedFacts ?? [],
      confirmedCauses: input.confirmedCauses ?? [],
      rejectedHypotheses: [],
      openQuestions: input.task.unknowns,
      relevantFiles: input.relevantFiles,
      latestFailure: input.latestFailure ?? null,
      sourceCommit: input.sourceCommit,
      ...(input.diffHash === undefined ? {} : { diffHash: input.diffHash }),
      nextAction: input.objective,
    });
    const selectedEvidence = this.evidenceSelector.select(input.evidence, input.phase, {
      maxItems: this.config.context.maxEvidenceItems,
      maxExcerptCharacters: this.config.context.maxExcerptCharacters,
    });
    const baseWithoutEstimate = {
      schemaVersion: 1 as const,
      contextPackVersion: 2 as const,
      phase: input.phase,
      objective: input.objective,
      task: {
        id: input.task.id,
        schemaVersion: input.task.schemaVersion,
        revision: input.task.revision,
        hash: hashJson(input.task),
      },
      taskBrief: {
        title: input.task.title,
        summary: input.task.summary,
        reports: input.task.reports,
        assumptions: input.task.assumptions,
        unknowns: input.task.unknowns,
        requestedScope: input.task.requestedScope,
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
      constraints: compactedState.constraints,
      protectedContracts: compactedState.protectedContracts,
      confirmedFacts: compactedState.confirmedFacts,
      confirmedCauses: compactedState.confirmedCauses,
      evidence: selectedEvidence,
      relevantFiles: compactedState.relevantFiles.slice(0, this.config.context.maxRelevantFiles),
      latestFailure:
        input.latestFailure === undefined || input.latestFailure === null
          ? null
          : input.latestFailure.slice(0, this.config.context.maxExcerptCharacters),
      expectedOutputSchema: input.outputSchema,
    };
    const preliminary = this.sizer.estimate(baseWithoutEstimate);
    const shouldCompact = preliminary.estimatedTokens > this.config.context.estimatedInputSoftLimit;
    const rotation = new ThreadRotationPolicy().decide({
      samePhase: false,
      sameObjective: true,
      sameFiles: true,
      directlyRelatedEvidence: true,
      modelChanged: false,
      scopeChanged: false,
      sourceCommitChanged: false,
      turnCount: 0,
      maxTurns: 1,
      projectedContextTokens: preliminary.estimatedTokens,
      softContextLimit: this.config.context.estimatedInputSoftLimit,
      noisyOutput: false,
      reviewerStarting: input.phase === "review",
    });
    const withoutEstimate = {
      ...baseWithoutEstimate,
      ...(shouldCompact
        ? {
            evidence: selectedEvidence.slice(
              0,
              Math.max(1, Math.ceil(selectedEvidence.length / 2)),
            ),
            relevantFiles: baseWithoutEstimate.relevantFiles.slice(
              0,
              Math.max(1, Math.ceil(baseWithoutEstimate.relevantFiles.length / 2)),
            ),
          }
        : {}),
      contextPolicy: {
        compacted: shouldCompact,
        threadRotated: true as const,
        reasons: rotation.reasons.length > 0 ? rotation.reasons : ["fresh bounded call"],
      },
    };
    const estimate = this.sizer.estimate(withoutEstimate);
    return contextPackSchema.parse({
      ...withoutEstimate,
      estimatedInputTokens: estimate.estimatedTokens,
      estimateSource: estimate.source,
    });
  }
}
