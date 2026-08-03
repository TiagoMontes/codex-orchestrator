import {
  Codex,
  type CodexOptions,
  type ModelReasoningEffort,
  type ThreadEvent,
  type ThreadOptions,
  type TurnOptions,
  type Usage,
} from "@openai/codex-sdk";
import type { ReasoningPreset } from "../../application/configuration/config-schema.js";
import { ZERO_ESTIMATED_USAGE, type NormalizedUsage } from "../../domain/usage/usage.js";
import { OrchestratorError } from "../../shared/errors.js";
import { EnvironmentSanitizer } from "../process/environment-sanitizer.js";
import { CodexEventRecorder } from "./codex-event-recorder.js";
import { parseStructuredOutput } from "./codex-output-parser.js";
import type {
  CodexCompatibilityMetadata,
  CodexRunRequest,
  CodexRunResult,
  CodexRuntime,
} from "./codex-runtime.js";
import {
  CodexRuntimeError,
  CodexTimeoutError,
  isModelEffortCompatibilityFailure,
} from "./codex-runtime-errors.js";

export interface SdkThreadLike {
  readonly id: string | null;
  runStreamed(
    input: string,
    options?: TurnOptions,
  ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
}

export interface SdkClientLike {
  startThread(options?: ThreadOptions): SdkThreadLike;
  resumeThread(id: string, options?: ThreadOptions): SdkThreadLike;
}

export type SdkClientFactory = (options: CodexOptions) => SdkClientLike;
export type EventRecorderFactory = (path: string) => CodexEventRecorder;

export type CodexSdkRuntimeOptions = {
  clientFactory?: SdkClientFactory;
  recorderFactory?: EventRecorderFactory;
  environment?: Readonly<Record<string, string | undefined>>;
  environmentSanitizer?: EnvironmentSanitizer;
  effortFallback?: Partial<Record<ReasoningPreset, readonly ModelReasoningEffort[]>>;
};

const SUPPORTED_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly ModelReasoningEffort[];

const DEFAULT_EFFORT_FALLBACK: Readonly<Record<ReasoningPreset, readonly ModelReasoningEffort[]>> =
  {
    minimal: ["minimal"],
    low: ["low", "minimal"],
    medium: ["medium", "low"],
    high: ["high", "medium"],
    deepest: ["xhigh", "high"],
  };

export class CodexSdkRuntime implements CodexRuntime {
  private readonly clientFactory: SdkClientFactory;
  private readonly recorderFactory: EventRecorderFactory;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly sanitizer: EnvironmentSanitizer;
  private readonly effortFallback: Readonly<
    Record<ReasoningPreset, readonly ModelReasoningEffort[]>
  >;

  constructor(options: CodexSdkRuntimeOptions = {}) {
    this.clientFactory = options.clientFactory ?? ((codexOptions) => new Codex(codexOptions));
    this.recorderFactory = options.recorderFactory ?? ((path) => new CodexEventRecorder(path));
    this.environment = options.environment ?? process.env;
    this.sanitizer = options.environmentSanitizer ?? new EnvironmentSanitizer();
    this.effortFallback = {
      ...DEFAULT_EFFORT_FALLBACK,
      ...options.effortFallback,
    };
  }

  async runStructured<T>(request: CodexRunRequest<T>): Promise<CodexRunResult<T>> {
    if (request.approvalPolicy !== "never") {
      throw new CodexRuntimeError("Codex approval policy must be never", { resumable: false });
    }
    const efforts = this.validatedEfforts(request.reasoningPreset);
    const recorder = this.recorderFactory(request.eventsPath);
    const controller = new AbortController();
    const timeoutReason = new CodexTimeoutError(request.timeoutMs);
    const timer = setTimeout(() => controller.abort(timeoutReason), request.timeoutMs);
    const forwardAbort = (): void => controller.abort(request.abortSignal?.reason);
    request.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
    if (request.abortSignal?.aborted ?? false) forwardAbort();

    let fallbackReason: string | undefined;
    try {
      for (let attempt = 0; attempt < Math.min(efforts.length, 2); attempt += 1) {
        const effort = efforts[attempt];
        if (effort === undefined) break;
        try {
          if (controller.signal.aborted) {
            throw controller.signal.reason;
          }
          const result = await this.runAttempt(request, effort, controller.signal, recorder);
          let output: T;
          try {
            output = parseStructuredOutput(result.finalResponse, request.outputValidator);
          } catch (validationError) {
            if (attempt > 0) throw validationError;
            await recorder.record({
              type: "runtime.output_repair",
              originalThreadId: result.threadId,
            });
            emitProgress(request, { role: request.role, kind: "output-repair" });
            const repairRequest = { ...request };
            delete repairRequest.resumeThreadId;
            repairRequest.prompt = repairPrompt(result.finalResponse, validationError);
            repairRequest.reasoningPreset = "minimal";
            let repair: Awaited<ReturnType<CodexSdkRuntime["runAttempt"]>>;
            try {
              repair = await this.runAttempt(repairRequest, "minimal", controller.signal, recorder);
            } catch (repairCallError) {
              throw new CodexRuntimeError("Codex structured-output repair call failed", {
                cause: repairCallError,
                resumable: true,
                compatibilityFailure: false,
              });
            }
            try {
              output = parseStructuredOutput(repair.finalResponse, request.outputValidator);
            } catch (repairError) {
              throw new CodexRuntimeError("Codex structured-output repair failed", {
                cause: repairError,
                resumable: true,
              });
            }
            const compatibility: CodexCompatibilityMetadata = {
              sdkVersion: "0.146.0",
              requestedReasoning: request.reasoningPreset,
              mappedReasoning: effort,
              fallbackApplied: false,
              missingUsageFields: [
                ...new Set([...result.missingUsageFields, ...repair.missingUsageFields]),
              ],
            };
            await recorder.record({ type: "runtime.compatibility", compatibility });
            return {
              threadId: repair.threadId,
              output,
              eventsPath: request.eventsPath,
              usage: addUsage(result.usage, repair.usage),
              finalResponse: repair.finalResponse,
              runtimeAttempts: 2,
              compatibility,
            };
          }
          const compatibility: CodexCompatibilityMetadata = {
            sdkVersion: "0.146.0",
            requestedReasoning: request.reasoningPreset,
            mappedReasoning: effort,
            fallbackApplied: attempt > 0,
            ...(fallbackReason === undefined ? {} : { fallbackReason }),
            missingUsageFields: result.missingUsageFields,
          };
          await recorder.record({ type: "runtime.compatibility", compatibility });
          return {
            threadId: result.threadId,
            output,
            eventsPath: request.eventsPath,
            usage: result.usage,
            finalResponse: result.finalResponse,
            runtimeAttempts: attempt + 1,
            compatibility,
          };
        } catch (error) {
          if (controller.signal.aborted) {
            await recorder.record({
              type: request.abortSignal?.aborted ? "runtime.cancelled" : "runtime.timeout",
            });
            emitProgress(request, {
              role: request.role,
              kind: request.abortSignal?.aborted ? "runtime-cancelled" : "runtime-timeout",
            });
            if (request.abortSignal?.aborted ?? false) {
              if (
                request.abortSignal?.reason instanceof OrchestratorError &&
                request.abortSignal.reason.code !== "CANCELLED"
              ) {
                throw request.abortSignal.reason;
              }
              throw new OrchestratorError("Codex call was cancelled", {
                code: "CANCELLED",
                resumable: true,
                cause: error,
              });
            }
            throw timeoutReason;
          }
          const runtimeError = normalizeRuntimeError(error);
          const canFallback =
            attempt === 0 && efforts.length > 1 && runtimeError.compatibilityFailure;
          if (!canFallback) throw runtimeError;
          fallbackReason = runtimeError.message;
          await recorder.record({
            type: "runtime.reasoning_fallback",
            from: effort,
            to: efforts[1],
            reason: fallbackReason,
          });
          emitProgress(request, { role: request.role, kind: "reasoning-fallback" });
        }
      }
      throw new CodexRuntimeError("No supported reasoning effort is available", {
        resumable: false,
      });
    } finally {
      clearTimeout(timer);
      request.abortSignal?.removeEventListener("abort", forwardAbort);
    }
  }

  private async runAttempt<T>(
    request: CodexRunRequest<T>,
    effort: ModelReasoningEffort,
    signal: AbortSignal,
    recorder: CodexEventRecorder,
  ): Promise<{
    threadId: string;
    finalResponse: string;
    usage: NormalizedUsage;
    missingUsageFields: string[];
  }> {
    const sanitized = this.sanitizer.sanitize(this.environment, {
      ...(request.additionalAllowedEnvironmentNames === undefined
        ? {}
        : { additionalAllowedNames: request.additionalAllowedEnvironmentNames }),
      ...(request.explicitSecretEnvironmentExceptions === undefined
        ? {}
        : { explicitSecretExceptions: request.explicitSecretEnvironmentExceptions }),
    });
    for (const warning of sanitized.warnings) {
      await recorder.record({ type: "runtime.environment_warning", warning });
    }
    const client = this.clientFactory({ env: sanitized.environment });
    const threadOptions: ThreadOptions = {
      model: request.model,
      modelReasoningEffort: effort,
      sandboxMode: request.sandboxMode,
      workingDirectory: request.workingDirectory,
      // Every phase is anchored to a registered repository or task worktree.
      skipGitRepoCheck: false,
      networkAccessEnabled: request.networkAccessEnabled,
      webSearchMode: "disabled",
      approvalPolicy: "never",
      additionalDirectories: [],
    };
    const thread =
      request.resumeThreadId === undefined
        ? client.startThread(threadOptions)
        : client.resumeThread(request.resumeThreadId, threadOptions);
    const streamed = await thread.runStreamed(request.prompt, {
      outputSchema: request.outputSchema,
      signal,
    });
    let threadId = request.resumeThreadId;
    let finalResponse = "";
    let usage: Usage | undefined;
    for await (const event of streamed.events) {
      await recorder.record(event);
      const progress = progressForEvent(request.role, event);
      if (progress !== undefined) emitProgress(request, progress);
      if (event.type === "thread.started") threadId = event.thread_id;
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        finalResponse = event.item.text;
      }
      if (event.type === "turn.completed") usage = event.usage;
      if (event.type === "turn.failed") {
        throw new CodexRuntimeError(event.error.message, {
          compatibilityFailure: isModelEffortCompatibilityFailure(event.error.message),
        });
      }
      if (event.type === "error") {
        throw new CodexRuntimeError(event.message, {
          compatibilityFailure: isModelEffortCompatibilityFailure(event.message),
        });
      }
    }
    threadId ??= thread.id ?? undefined;
    if (threadId === undefined) {
      throw new CodexRuntimeError("Codex stream did not provide a thread ID");
    }
    const normalized = normalizeUsage(usage);
    return {
      threadId,
      finalResponse,
      usage: normalized.usage,
      missingUsageFields: normalized.missingFields,
    };
  }

  private validatedEfforts(preset: ReasoningPreset): readonly ModelReasoningEffort[] {
    const configured = this.effortFallback[preset];
    const valid = configured.filter((effort) => SUPPORTED_EFFORTS.includes(effort));
    if (valid.length === 0) {
      throw new CodexRuntimeError(`No SDK-supported effort is configured for ${preset}`, {
        resumable: false,
      });
    }
    return valid;
  }
}

function emitProgress<T>(
  request: CodexRunRequest<T>,
  event: Parameters<NonNullable<CodexRunRequest<T>["progress"]>>[0],
): void {
  try {
    request.progress?.(event);
  } catch {
    // Observability must never change orchestration semantics.
  }
}

function progressForEvent(
  role: CodexRunRequest<unknown>["role"],
  event: ThreadEvent,
): Parameters<NonNullable<CodexRunRequest<unknown>["progress"]>>[0] | undefined {
  if (event.type === "thread.started") return { role, kind: "thread-started" };
  if (event.type === "item.completed" && event.item.type === "command_execution") {
    return {
      role,
      kind: "command-completed",
      status: event.item.status,
      ...(event.item.exit_code === undefined ? {} : { exitCode: event.item.exit_code }),
    };
  }
  if (event.type === "item.completed" && event.item.type === "mcp_tool_call") {
    return {
      role,
      kind: "tool-completed",
      server: event.item.server,
      tool: event.item.tool,
      status: event.item.status,
    };
  }
  if (event.type === "turn.completed") {
    return { role, kind: "turn-completed", usage: normalizeUsage(event.usage).usage };
  }
  if (event.type === "turn.failed" || event.type === "error") {
    return { role, kind: "turn-failed" };
  }
  return undefined;
}

function repairPrompt(invalidOutput: string, validationError: unknown): string {
  const errorMessage =
    validationError instanceof Error ? validationError.message : "Structured validation failed";
  return [
    "Repair the invalid structured output below.",
    "Return only one JSON value matching the supplied output schema.",
    "Do not add commentary and do not infer facts beyond the invalid output.",
    "",
    "Validation error:",
    errorMessage.slice(0, 2_000),
    "",
    "Invalid output:",
    invalidOutput.slice(0, 8_000),
  ].join("\n");
}

function addUsage(left: NormalizedUsage, right: NormalizedUsage): NormalizedUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteInputTokens: left.cacheWriteInputTokens + right.cacheWriteInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    source: left.source === "actual" && right.source === "actual" ? "actual" : "estimated",
  };
}

export function normalizeUsage(usage: Partial<Usage> | undefined): {
  usage: NormalizedUsage;
  missingFields: string[];
} {
  if (usage === undefined) {
    return {
      usage: ZERO_ESTIMATED_USAGE,
      missingFields: [
        "input_tokens",
        "cached_input_tokens",
        "cache_write_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
      ],
    };
  }
  const missingFields: string[] = [];
  const field = (name: keyof Usage): number => {
    const value = usage[name];
    if (value === undefined) {
      missingFields.push(name);
      return 0;
    }
    return value;
  };
  const inputTokens = field("input_tokens");
  const outputTokens = field("output_tokens");
  return {
    usage: {
      inputTokens,
      cachedInputTokens: field("cached_input_tokens"),
      cacheWriteInputTokens: field("cache_write_input_tokens"),
      outputTokens,
      reasoningOutputTokens: field("reasoning_output_tokens"),
      totalTokens: inputTokens + outputTokens,
      source: "actual",
    },
    missingFields,
  };
}

function normalizeRuntimeError(error: unknown): CodexRuntimeError {
  if (error instanceof CodexRuntimeError) return error;
  return new CodexRuntimeError(
    error instanceof Error ? error.message : "Unknown Codex runtime failure",
    {
      cause: error,
      compatibilityFailure:
        error instanceof Error && isModelEffortCompatibilityFailure(error.message),
    },
  );
}
