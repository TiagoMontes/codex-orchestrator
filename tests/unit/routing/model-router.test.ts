import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../../src/application/configuration/default-config.js";
import { ModelRouter } from "../../../src/orchestration/routing/model-router.js";
import { routingTestTask as task } from "../../helpers/task-fixture.js";

describe("ModelRouter", () => {
  it("routes normalization to the configured cheap model", () => {
    const decision = new ModelRouter(DEFAULT_CONFIG).route({
      phase: "normalization",
      profile: "balanced",
      estimatedCallTokens: 1_000,
      remainingBudgetTokens: 120_000,
    });
    expect(decision).toMatchObject({ model: "gpt-5.6-luna", reasoning: "low", modelAlias: "fast" });
  });

  it("routes high-risk logic to the capable model", () => {
    const decision = new ModelRouter(DEFAULT_CONFIG).route({
      phase: "diagnosis",
      task: { ...task, risk: "high", riskSignals: ["authentication-or-authorization"] },
      profile: "balanced",
      estimatedCallTokens: 10_000,
      remainingBudgetTokens: 100_000,
    });
    expect(decision).toMatchObject({ model: "gpt-5.6", reasoning: "high", modelAlias: "capable" });
  });

  it("applies profile downgrades and validates manual overrides", () => {
    const router = new ModelRouter(DEFAULT_CONFIG);
    const economy = router.route({
      phase: "diagnosis",
      task: { ...task, risk: "critical" },
      profile: "economy",
      estimatedCallTokens: 5_000,
      remainingBudgetTokens: 50_000,
    });
    expect(economy.model).toBe("gpt-5.6-terra");
    expect(economy.fallbackOrDowngrade).toContain("disallows the capable model");
    expect(() =>
      router.route({
        phase: "diagnosis",
        task,
        profile: "economy",
        estimatedCallTokens: 5_000,
        remainingBudgetTokens: 50_000,
        overrides: { model: "gpt-5.6" },
      }),
    ).toThrow("does not allow the capable model override");
  });

  it("blocks when remaining budget cannot admit the estimate", () => {
    expect(() =>
      new ModelRouter(DEFAULT_CONFIG).route({
        phase: "diagnosis",
        task,
        profile: "balanced",
        estimatedCallTokens: 10_001,
        remainingBudgetTokens: 10_000,
      }),
    ).toThrow("Remaining task budget");
  });
});
