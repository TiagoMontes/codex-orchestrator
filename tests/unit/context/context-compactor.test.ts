import { describe, expect, it } from "vitest";
import { ContextCompactor } from "../../../src/orchestration/context/context-compactor.js";

describe("ContextCompactor", () => {
  it("deduplicates exploration while preserving exact durable constraints and failure", () => {
    const compacted = new ContextCompactor().compact({
      acceptanceCriteria: ["must pass", "must pass"],
      constraints: ["no migrations"],
      protectedContracts: ["public API"],
      humanDecisions: ["use main"],
      confirmedFacts: ["route exists", "route exists"],
      confirmedCauses: ["off by one"],
      rejectedHypotheses: ["database"],
      openQuestions: [],
      relevantFiles: ["src/a.ts", "src/a.ts"],
      latestFailure: "test x expected 2 received 3",
      sourceCommit: "abc",
      diffHash: "def",
      nextAction: "fix boundary",
    });
    expect(compacted.acceptanceCriteria).toEqual(["must pass"]);
    expect(compacted.confirmedFacts).toEqual(["route exists"]);
    expect(compacted.latestFailure).toBe("test x expected 2 received 3");
    expect(compacted).toMatchObject({ sourceCommit: "abc", diffHash: "def" });
  });
});
