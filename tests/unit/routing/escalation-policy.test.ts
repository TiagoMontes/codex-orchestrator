import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../../../src/application/configuration/default-config.js";
import { EscalationPolicy } from "../../../src/orchestration/routing/escalation-policy.js";
import { ModelRouter } from "../../../src/orchestration/routing/model-router.js";
import { routingTestTask } from "../../helpers/task-fixture.js";

describe("EscalationPolicy", () => {
  const current = new ModelRouter(DEFAULT_CONFIG).route({
    phase: "diagnosis",
    task: routingTestTask,
    profile: "balanced",
    estimatedCallTokens: 10_000,
    remainingBudgetTokens: 100_000,
  });

  it("requires new evidence", () => {
    expect(
      new EscalationPolicy(DEFAULT_CONFIG).evaluate({
        current,
        profile: "balanced",
        failedOrUnresolved: true,
        hasNewEvidence: false,
        remainingBudgetTokens: 90_000,
        estimatedNextCallTokens: 10_000,
      }),
    ).toEqual({ allowed: false, reason: "Escalation requires new evidence" });
  });

  it("escalates one configured tier with evidence and budget", () => {
    expect(
      new EscalationPolicy(DEFAULT_CONFIG).evaluate({
        current,
        profile: "balanced",
        failedOrUnresolved: true,
        hasNewEvidence: true,
        remainingBudgetTokens: 90_000,
        estimatedNextCallTokens: 10_000,
      }),
    ).toMatchObject({ allowed: true, model: "gpt-5.6-terra", reasoning: "high" });
  });
});
