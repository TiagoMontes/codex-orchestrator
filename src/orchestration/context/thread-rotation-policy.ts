export type ThreadContinuationState = {
  samePhase: boolean;
  sameObjective: boolean;
  sameFiles: boolean;
  directlyRelatedEvidence: boolean;
  modelChanged: boolean;
  scopeChanged: boolean;
  sourceCommitChanged: boolean;
  turnCount: number;
  maxTurns: number;
  projectedContextTokens: number;
  softContextLimit: number;
  noisyOutput: boolean;
  reviewerStarting: boolean;
};

export type ThreadRotationDecision = {
  rotate: boolean;
  reasons: string[];
};

export class ThreadRotationPolicy {
  decide(state: ThreadContinuationState): ThreadRotationDecision {
    const reasons: string[] = [];
    if (!state.samePhase) reasons.push("phase changed");
    if (!state.sameObjective) reasons.push("objective changed");
    if (!state.sameFiles) reasons.push("file set changed");
    if (!state.directlyRelatedEvidence) reasons.push("evidence is not directly related");
    if (state.modelChanged) reasons.push("model tier changed");
    if (state.scopeChanged) reasons.push("scope changed materially");
    if (state.sourceCommitChanged) reasons.push("source commit changed");
    if (state.turnCount >= state.maxTurns) reasons.push("turn limit reached");
    if (state.projectedContextTokens > state.softContextLimit)
      reasons.push("soft context limit exceeded");
    if (state.noisyOutput) reasons.push("prior thread is noisy");
    if (state.reviewerStarting) reasons.push("reviewer requires an independent thread");
    return { rotate: reasons.length > 0, reasons };
  }
}
