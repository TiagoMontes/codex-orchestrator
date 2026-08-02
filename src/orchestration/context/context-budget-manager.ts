import type { AppConfig, ExecutionProfile } from "../../application/configuration/config-schema.js";
import type { ExecutionPhase } from "../../domain/execution/execution.js";
import type { UsageReservation } from "../../domain/usage/usage-ledger.js";
import { OrchestratorError } from "../../shared/errors.js";
import type { UsageFileRepository } from "../../infrastructure/persistence/usage-file-repository.js";

export type BudgetAdmissionInput = {
  projectId: string;
  taskId: string;
  phase: ExecutionPhase;
  profile: ExecutionProfile;
  estimatedInputTokens: number;
  activeParallelReaders: number;
  workerId?: string;
  projectedAgentCalls?: number;
};

export type BudgetAdmission = {
  allowed: true;
  projectedTokens: number;
  projectedAgentCalls: number;
  requiresCompaction: boolean;
  reservation: UsageReservation;
};

export class ContextBudgetManager {
  constructor(
    private readonly config: AppConfig,
    private readonly usage: UsageFileRepository,
  ) {}

  async admitAndReserve(input: BudgetAdmissionInput): Promise<BudgetAdmission> {
    if (input.estimatedInputTokens > this.config.context.estimatedInputHardLimit) {
      throw new OrchestratorError("Estimated input exceeds the hard context limit", {
        code: "BUDGET",
        resumable: true,
      });
    }
    const limits = this.config.profiles[input.profile];
    if (input.activeParallelReaders > limits.maxParallelReaders) {
      throw new OrchestratorError("Parallel reader limit would be exceeded", {
        code: "BUDGET",
        resumable: true,
      });
    }
    const projectedTokens = input.estimatedInputTokens + this.config.context.reservedOutputTokens;
    const projectedAgentCalls = input.projectedAgentCalls ?? 1;
    const reservation = await this.usage.reserve({
      projectId: input.projectId,
      taskId: input.taskId,
      phase: input.phase,
      projectedTokens,
      maxTotalTokens: limits.maxTotalTokens,
      maxAgentCalls: limits.maxAgentCalls,
      projectedCalls: projectedAgentCalls,
      ...(input.workerId === undefined ? {} : { workerId: input.workerId }),
    });
    return {
      allowed: true,
      projectedTokens,
      projectedAgentCalls,
      requiresCompaction: input.estimatedInputTokens > this.config.context.estimatedInputSoftLimit,
      reservation,
    };
  }
}
