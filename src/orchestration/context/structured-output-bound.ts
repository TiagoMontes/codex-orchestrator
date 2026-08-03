import type { AppConfig } from "../../application/configuration/config-schema.js";
import { OrchestratorError } from "../../shared/errors.js";
import { ContextSizer } from "./context-sizer.js";

export function assertStructuredOutputBounded(output: unknown, config: AppConfig): void {
  const estimate = new ContextSizer(config.context.tokenEstimateSafetyMultiplier).estimate(output);
  if (estimate.estimatedTokens > config.context.reservedOutputTokens) {
    throw new OrchestratorError(
      `Structured output exceeds the reserved output budget (${estimate.estimatedTokens} > ${config.context.reservedOutputTokens})`,
      { code: "BUDGET", resumable: true },
    );
  }
}
