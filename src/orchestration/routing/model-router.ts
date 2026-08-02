import type {
  AppConfig,
  ExecutionProfile,
  ReasoningPreset,
} from "../../application/configuration/config-schema.js";
import type { ExecutionPhase } from "../../domain/execution/execution.js";
import { modelDecisionSchema, type ModelDecision } from "../../domain/execution/model-decision.js";
import type { Task } from "../../domain/task/task.js";
import { OrchestratorError } from "../../shared/errors.js";
import { CapabilityRegistry, type ModelAlias } from "./capability-registry.js";
import { profileLimits } from "./profiles.js";
import { TaskClassifier } from "./task-classifier.js";

export type RoutingOverrides = {
  model?: string;
  reasoning?: ReasoningPreset;
};

export type ModelRoutingInput = {
  phase: ExecutionPhase;
  task?: Task;
  profile: ExecutionProfile;
  estimatedCallTokens: number;
  remainingBudgetTokens: number;
  priorFailedAttempts?: number;
  overrides?: RoutingOverrides;
};

type RouteTarget = { alias: ModelAlias; reasoning: ReasoningPreset; reason: string };

export class ModelRouter {
  private readonly capabilities: CapabilityRegistry;
  private readonly classifier = new TaskClassifier();

  constructor(private readonly config: AppConfig) {
    this.capabilities = new CapabilityRegistry(config);
  }

  route(input: ModelRoutingInput): ModelDecision {
    if (input.estimatedCallTokens > input.remainingBudgetTokens) {
      throw new OrchestratorError("Remaining task budget cannot admit the routed call", {
        code: "BUDGET",
        resumable: true,
      });
    }
    const classification =
      input.task === undefined ? undefined : this.classifier.classify(input.task);
    const initial = this.target(input.phase, input.task, classification?.complexity ?? "standard");
    const limits = profileLimits(this.config, input.profile);
    let alias = initial.alias;
    let reasoning = initial.reasoning;
    let downgrade: string | undefined;

    if (alias === "capable" && !limits.allowCapableModel) {
      alias = "efficient";
      downgrade = `Profile ${input.profile} disallows the capable model; routed to efficient`;
    }
    if (reasoning === "deepest" && !limits.allowDeepestReasoning) {
      reasoning = "high";
      downgrade = [
        downgrade,
        `Profile ${input.profile} disallows deepest reasoning; routed to high`,
      ]
        .filter(Boolean)
        .join("; ");
    }

    const override = input.overrides ?? {};
    const model = override.model ?? this.capabilities.resolve(alias);
    const resolvedAlias = this.capabilities.aliasFor(model);
    const finalReasoning = override.reasoning ?? reasoning;
    if (this.capabilities.isCapable(model) && !limits.allowCapableModel) {
      throw new OrchestratorError(
        `Profile ${input.profile} does not allow the capable model override`,
        {
          code: "CLI_INPUT",
        },
      );
    }
    if (finalReasoning === "deepest" && !limits.allowDeepestReasoning) {
      throw new OrchestratorError(`Profile ${input.profile} does not allow deepest reasoning`, {
        code: "CLI_INPUT",
      });
    }

    const routingSignals = [
      `phase:${input.phase}`,
      `profile:${input.profile}`,
      ...(classification?.signals ?? []),
      `prior-failures:${input.priorFailedAttempts ?? 0}`,
      override.model === undefined ? "model:auto" : "model:manual-override",
      override.reasoning === undefined ? "reasoning:auto" : "reasoning:manual-override",
    ];
    return modelDecisionSchema.parse({
      schemaVersion: 1,
      phase: input.phase,
      profile: input.profile,
      ...(resolvedAlias === undefined ? {} : { modelAlias: resolvedAlias }),
      model,
      reasoning: finalReasoning,
      routingSignals,
      reason: initial.reason,
      estimatedCallTokens: input.estimatedCallTokens,
      remainingBudgetTokens: input.remainingBudgetTokens,
      manualOverrides: {
        ...(override.model === undefined ? {} : { model: override.model }),
        ...(override.reasoning === undefined ? {} : { reasoning: override.reasoning }),
      },
      ...(downgrade === undefined ? {} : { fallbackOrDowngrade: downgrade }),
    });
  }

  private target(
    phase: ExecutionPhase,
    task: Task | undefined,
    complexity: "simple" | "standard" | "complex",
  ): RouteTarget {
    if (phase === "normalization") {
      const rule = this.config.routing.normalization;
      return {
        alias: rule.modelAlias,
        reasoning: rule.reasoning,
        reason: "Normalization uses the cheapest configured structured-output route",
      };
    }
    if (phase === "exploration") {
      const rule = this.config.routing.repositoryExploration;
      return {
        alias: rule.modelAlias,
        reasoning: rule.reasoning,
        reason: "Repository exploration uses the configured read-efficient route",
      };
    }
    if (phase === "diagnosis") {
      const rule =
        complexity === "complex" || isHighRisk(task)
          ? this.config.routing.complexDiagnosis
          : this.config.routing.standardDiagnosis;
      return {
        alias: rule.modelAlias,
        reasoning: rule.reasoning,
        reason: isHighRisk(task)
          ? "High-risk diagnosis requires the capable route"
          : `${complexity} diagnosis route`,
      };
    }
    if (phase === "implementation" || phase === "correction") {
      const rule =
        complexity === "complex" || isHighRisk(task)
          ? this.config.routing.complexImplementation
          : this.config.routing.standardImplementation;
      return {
        alias: rule.modelAlias,
        reasoning: rule.reasoning,
        reason: isHighRisk(task)
          ? "High-risk implementation requires the capable route"
          : `${complexity} implementation route`,
      };
    }
    if (phase === "review") {
      const rule =
        task?.risk === "critical"
          ? this.config.routing.criticalReview
          : this.config.routing.independentReview;
      return {
        alias: rule.modelAlias,
        reasoning: rule.reasoning,
        reason:
          task?.risk === "critical"
            ? "Critical-risk work requires deepest independent review"
            : "Independent review uses the capable route",
      };
    }
    if (phase === "audit") {
      const rule =
        complexity === "complex"
          ? this.config.routing.complexDiagnosis
          : this.config.routing.repositoryExploration;
      return {
        alias: rule.modelAlias,
        reasoning: rule.reasoning,
        reason: `${complexity} repository audit route`,
      };
    }
    const rule = this.config.routing.cheapClassification;
    return {
      alias: rule.modelAlias,
      reasoning: rule.reasoning,
      reason: "Deterministic verification does not require an agent; fallback route is cheap",
    };
  }
}

function isHighRisk(task: Task | undefined): boolean {
  return task?.risk === "high" || task?.risk === "critical";
}
