import { describe, expect, it } from "vitest";
import { ThreadRotationPolicy } from "../../../src/orchestration/context/thread-rotation-policy.js";

const continuable = {
  samePhase: true,
  sameObjective: true,
  sameFiles: true,
  directlyRelatedEvidence: true,
  modelChanged: false,
  scopeChanged: false,
  sourceCommitChanged: false,
  turnCount: 1,
  maxTurns: 3,
  projectedContextTokens: 10_000,
  softContextLimit: 30_000,
  noisyOutput: false,
  reviewerStarting: false,
};

describe("ThreadRotationPolicy", () => {
  it("continues only a small related turn in the same phase", () => {
    expect(new ThreadRotationPolicy().decide(continuable)).toEqual({ rotate: false, reasons: [] });
  });

  it("always rotates for a reviewer or turn limit", () => {
    const decision = new ThreadRotationPolicy().decide({
      ...continuable,
      reviewerStarting: true,
      turnCount: 3,
    });
    expect(decision.rotate).toBe(true);
    expect(decision.reasons).toContain("reviewer requires an independent thread");
    expect(decision.reasons).toContain("turn limit reached");
  });
});
