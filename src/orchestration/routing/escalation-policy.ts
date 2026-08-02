import type {
  AppConfig,
  ExecutionProfile,
  ReasoningPreset,
} from "../../application/configuration/config-schema.js";
import type { ModelDecision } from "../../domain/execution/model-decision.js";
import { CapabilityRegistry } from "./capability-registry.js";
import { profileLimits } from "./profiles.js";

export type EscalationInput = {
  current: ModelDecision;
  profile: ExecutionProfile;
  failedOrUnresolved: boolean;
  hasNewEvidence: boolean;
  remainingBudgetTokens: number;
  estimatedNextCallTokens: number;
};

export type EscalationDecision =
  | {
      allowed: true;
      model: string;
      reasoning: ReasoningPreset;
      reason: string;
    }
  | { allowed: false; reason: string };

export class EscalationPolicy {
  private readonly capabilities: CapabilityRegistry;

  constructor(private readonly config: AppConfig) {
    this.capabilities = new CapabilityRegistry(config);
  }

  evaluate(input: EscalationInput): EscalationDecision {
    if (!input.failedOrUnresolved)
      return { allowed: false, reason: "Current attempt did not fail or remain unresolved" };
    if (!input.hasNewEvidence)
      return { allowed: false, reason: "Escalation requires new evidence" };
    if (input.estimatedNextCallTokens > input.remainingBudgetTokens) {
      return { allowed: false, reason: "Insufficient remaining budget for escalation" };
    }
    const next = nextTier(input.current, this.config);
    if (next === undefined) return { allowed: false, reason: "No higher configured tier remains" };
    const limits = profileLimits(this.config, input.profile);
    if (this.capabilities.isCapable(next.model) && !limits.allowCapableModel) {
      return {
        allowed: false,
        reason: `Profile ${input.profile} disallows capable-model escalation`,
      };
    }
    if (next.reasoning === "deepest" && !limits.allowDeepestReasoning) {
      return {
        allowed: false,
        reason: `Profile ${input.profile} disallows deepest-reasoning escalation`,
      };
    }
    return {
      allowed: true,
      model: next.model,
      reasoning: next.reasoning,
      reason: `Escalated after failed or unresolved attempt with new evidence; ${input.remainingBudgetTokens} tokens remained`,
    };
  }
}

function nextTier(
  current: ModelDecision,
  config: AppConfig,
): { model: string; reasoning: ReasoningPreset } | undefined {
  const efficient = config.models.aliases.efficient;
  const capable = config.models.aliases.capable;
  if (current.model === efficient && current.reasoning === "medium") {
    return { model: efficient, reasoning: "high" };
  }
  if (current.model === efficient && current.reasoning === "high") {
    return { model: capable, reasoning: "high" };
  }
  if (current.model === capable && current.reasoning === "high") {
    return { model: capable, reasoning: "deepest" };
  }
  return undefined;
}
