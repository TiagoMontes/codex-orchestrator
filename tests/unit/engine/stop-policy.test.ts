import { describe, expect, it } from "vitest";
import { StopPolicy } from "../../../src/orchestration/engine/stop-policy.js";

describe("StopPolicy", () => {
  it("blocks an identical failure without new evidence", () => {
    expect(
      new StopPolicy().evaluate({
        cancelled: false,
        budgetAvailable: true,
        sourceCommitChanged: false,
        repeatedFailureSignature: true,
        hasNewEvidence: false,
        attempts: 1,
        maximumAttempts: 3,
      }),
    ).toEqual({
      stop: true,
      status: "blocked",
      reason: "repeated_failure_without_new_evidence",
    });
  });

  it("permits a bounded retry with new evidence", () => {
    expect(
      new StopPolicy().evaluate({
        cancelled: false,
        budgetAvailable: true,
        sourceCommitChanged: false,
        repeatedFailureSignature: false,
        hasNewEvidence: true,
        attempts: 1,
        maximumAttempts: 3,
      }),
    ).toEqual({ stop: false });
  });
});
