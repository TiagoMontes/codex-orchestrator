import { describe, expect, it } from "vitest";
import { ContextSizer } from "../../../src/orchestration/context/context-sizer.js";

describe("ContextSizer", () => {
  it("applies the documented character heuristic and safety multiplier", () => {
    const estimate = new ContextSizer(1.3).estimate("a".repeat(4_000));
    expect(estimate).toEqual({
      rawCharacters: 4_000,
      estimatedTokens: 1_300,
      source: "estimated",
      heuristic: "utf16-characters-divided-by-four",
      safetyMultiplier: 1.3,
    });
  });
});
