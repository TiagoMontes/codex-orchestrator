export type CompactionInput = {
  acceptanceCriteria: readonly string[];
  constraints: readonly string[];
  protectedContracts: readonly string[];
  humanDecisions: readonly string[];
  confirmedFacts: readonly string[];
  confirmedCauses: readonly string[];
  rejectedHypotheses: readonly string[];
  openQuestions: readonly string[];
  relevantFiles: readonly string[];
  latestFailure: string | null;
  sourceCommit: string;
  diffHash?: string;
  nextAction: string;
};

export type CompactedContext = {
  acceptanceCriteria: string[];
  constraints: string[];
  protectedContracts: string[];
  humanDecisions: string[];
  confirmedFacts: string[];
  confirmedCauses: string[];
  rejectedHypotheses: string[];
  openQuestions: string[];
  relevantFiles: string[];
  latestFailure: string | null;
  sourceCommit: string;
  diffHash?: string;
  nextAction: string;
};

export class ContextCompactor {
  compact(input: CompactionInput): CompactedContext {
    return {
      acceptanceCriteria: unique(input.acceptanceCriteria),
      constraints: unique(input.constraints),
      protectedContracts: unique(input.protectedContracts),
      humanDecisions: unique(input.humanDecisions),
      confirmedFacts: unique(input.confirmedFacts),
      confirmedCauses: unique(input.confirmedCauses),
      rejectedHypotheses: unique(input.rejectedHypotheses),
      openQuestions: unique(input.openQuestions),
      relevantFiles: unique(input.relevantFiles),
      latestFailure: input.latestFailure,
      sourceCommit: input.sourceCommit,
      ...(input.diffHash === undefined ? {} : { diffHash: input.diffHash }),
      nextAction: input.nextAction,
    };
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
