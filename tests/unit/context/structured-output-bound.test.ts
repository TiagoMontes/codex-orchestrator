import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../../src/application/configuration/default-config.js";
import { assertStructuredOutputBounded } from "../../../src/orchestration/context/structured-output-bound.js";

describe("structured output bound", () => {
  it("accepts concise output and rejects oversized validated structures", () => {
    expect(() =>
      assertStructuredOutputBounded({ summary: "concise" }, DEFAULT_CONFIG),
    ).not.toThrow();
    expect(() =>
      assertStructuredOutputBounded({ nested: ["x".repeat(100_000)] }, DEFAULT_CONFIG),
    ).toThrow("exceeds the reserved output budget");
  });
});
