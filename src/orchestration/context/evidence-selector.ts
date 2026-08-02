import type { Evidence } from "../../domain/evidence/evidence.js";
import type { ExecutionPhase } from "../../domain/execution/execution.js";

export type EvidenceSelectionLimits = {
  maxItems: number;
  maxExcerptCharacters: number;
};

export class EvidenceSelector {
  select(
    evidence: readonly Evidence[],
    phase: ExecutionPhase,
    limits: EvidenceSelectionLimits,
  ): Evidence[] {
    return [...evidence]
      .sort(
        (left, right) =>
          score(right, phase) - score(left, phase) ||
          right.observedAt.localeCompare(left.observedAt),
      )
      .slice(0, limits.maxItems)
      .map((item) => ({
        ...item,
        ...(item.excerpt === undefined
          ? {}
          : { excerpt: item.excerpt.slice(0, limits.maxExcerptCharacters) }),
      }));
  }
}

function score(evidence: Evidence, phase: ExecutionPhase): number {
  let value = evidence.status === "confirmed" ? 100 : evidence.status === "unverified" ? 30 : 10;
  if (phase === "verification" && (evidence.kind === "test" || evidence.kind === "command"))
    value += 50;
  if (phase === "review" && (evidence.kind === "review" || evidence.kind === "test")) value += 50;
  if (
    phase === "diagnosis" &&
    (evidence.kind === "file" || evidence.kind === "symbol" || evidence.kind === "log")
  ) {
    value += 40;
  }
  return value;
}
