export type StopPolicyInput = {
  cancelled: boolean;
  budgetAvailable: boolean;
  sourceCommitChanged: boolean;
  repeatedFailureSignature: boolean;
  hasNewEvidence: boolean;
  attempts: number;
  maximumAttempts: number;
};

export type StopDecision =
  | { stop: false }
  | {
      stop: true;
      status: "cancelled" | "blocked";
      reason:
        | "cancelled"
        | "budget_exhausted"
        | "source_commit_changed"
        | "repeated_failure_without_new_evidence"
        | "attempt_limit_reached"
        | "retry_without_new_evidence";
    };

export class StopPolicy {
  evaluate(input: StopPolicyInput): StopDecision {
    if (input.cancelled) return { stop: true, status: "cancelled", reason: "cancelled" };
    if (!input.budgetAvailable)
      return { stop: true, status: "blocked", reason: "budget_exhausted" };
    if (input.sourceCommitChanged) {
      return { stop: true, status: "blocked", reason: "source_commit_changed" };
    }
    if (input.repeatedFailureSignature && !input.hasNewEvidence) {
      return {
        stop: true,
        status: "blocked",
        reason: "repeated_failure_without_new_evidence",
      };
    }
    if (input.attempts >= input.maximumAttempts) {
      return { stop: true, status: "blocked", reason: "attempt_limit_reached" };
    }
    if (input.attempts > 0 && !input.hasNewEvidence) {
      return { stop: true, status: "blocked", reason: "retry_without_new_evidence" };
    }
    return { stop: false };
  }
}
