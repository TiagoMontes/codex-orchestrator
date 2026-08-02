import type { ZodType } from "zod";
import type { ReasoningPreset } from "../../application/configuration/config-schema.js";
import type { NormalizedUsage } from "../../domain/usage/usage.js";

export type AgentRole =
  | "normalizer"
  | "repository-explorer"
  | "diagnostician"
  | "implementer"
  | "reviewer"
  | "audit-mapper"
  | "corrector"
  | "read-worker";

export type CodexRunRequest<T> = {
  role: AgentRole;
  prompt: string;
  workingDirectory: string;
  model: string;
  reasoningPreset: ReasoningPreset;
  sandboxMode: "read-only" | "workspace-write";
  approvalPolicy: "never";
  networkAccessEnabled: boolean;
  outputSchema: Record<string, unknown>;
  outputValidator: ZodType<T>;
  timeoutMs: number;
  eventsPath: string;
  abortSignal?: AbortSignal;
  resumeThreadId?: string;
};

export type CodexCompatibilityMetadata = {
  sdkVersion: "0.146.0";
  requestedReasoning: ReasoningPreset;
  mappedReasoning: "minimal" | "low" | "medium" | "high" | "xhigh";
  fallbackApplied: boolean;
  fallbackReason?: string;
  missingUsageFields: string[];
};

export type CodexRunResult<T> = {
  threadId: string;
  output: T;
  eventsPath: string;
  usage: NormalizedUsage;
  finalResponse: string;
  runtimeAttempts: number;
  compatibility: CodexCompatibilityMetadata;
};

export interface CodexRuntime {
  runStructured<T>(request: CodexRunRequest<T>): Promise<CodexRunResult<T>>;
}
