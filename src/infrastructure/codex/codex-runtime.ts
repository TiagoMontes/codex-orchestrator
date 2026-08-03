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

export type CodexProgressEvent =
  | { role: AgentRole; kind: "thread-started" }
  | {
      role: AgentRole;
      kind: "command-completed";
      status: string;
      exitCode?: number;
    }
  | {
      role: AgentRole;
      kind: "tool-completed";
      server: string;
      tool: string;
      status: string;
    }
  | { role: AgentRole; kind: "turn-completed"; usage: NormalizedUsage }
  | { role: AgentRole; kind: "turn-failed" | "runtime-timeout" | "runtime-cancelled" }
  | { role: AgentRole; kind: "output-repair" | "reasoning-fallback" };

export type CodexProgressObserver = (event: CodexProgressEvent) => void;

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
  additionalAllowedEnvironmentNames?: readonly string[];
  explicitSecretEnvironmentExceptions?: readonly string[];
  progress?: CodexProgressObserver;
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
