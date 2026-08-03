import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ConfigService } from "../../../src/application/configuration/config-service.js";
import { DEFAULT_CONFIG } from "../../../src/application/configuration/default-config.js";
import { ConfiguredCodexRuntime } from "../../../src/infrastructure/codex/configured-codex-runtime.js";
import type {
  CodexRunRequest,
  CodexRunResult,
  CodexRuntime,
} from "../../../src/infrastructure/codex/codex-runtime.js";
import type { CodexSdkRuntimeOptions } from "../../../src/infrastructure/codex/codex-sdk-runtime.js";

describe("ConfiguredCodexRuntime", () => {
  it("applies the current effort, environment, and event-cap policy to each delegated call", async () => {
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      models: {
        ...DEFAULT_CONFIG.models,
        reasoningFallback: { ...DEFAULT_CONFIG.models.reasoningFallback, deepest: ["high"] },
      },
      storage: { ...DEFAULT_CONFIG.storage, maxEventLogBytes: 420 },
      security: { ...DEFAULT_CONFIG.security, environmentAllowlist: ["PATH"] },
    };
    const configService = { load: () => Promise.resolve(config) } as unknown as ConfigService;
    const expected: CodexRunResult<{ answer: string }> = {
      threadId: "configured-thread",
      output: { answer: "ok" },
      eventsPath: "/tmp/configured-events.jsonl",
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        totalTokens: 2,
        source: "actual",
      },
      finalResponse: '{"answer":"ok"}',
      runtimeAttempts: 1,
      compatibility: {
        sdkVersion: "0.146.0",
        requestedReasoning: "deepest",
        mappedReasoning: "high",
        fallbackApplied: true,
        missingUsageFields: [],
      },
    };
    const delegated = {
      runStructured: () => Promise.resolve(expected),
    } as unknown as CodexRuntime;
    let captured: CodexSdkRuntimeOptions | undefined;
    const runtime = new ConfiguredCodexRuntime(
      configService,
      { PATH: "/usr/bin", HOME: "/private/home", API_TOKEN: "hidden" },
      (options) => {
        captured = options;
        return delegated;
      },
    );
    const request: CodexRunRequest<{ answer: string }> = {
      role: "diagnostician",
      prompt: "diagnose",
      workingDirectory: "/tmp",
      model: "gpt-5.6",
      reasoningPreset: "deepest",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      outputSchema: { type: "object" },
      outputValidator: z.object({ answer: z.string() }),
      timeoutMs: 1_000,
      eventsPath: expected.eventsPath,
    };

    await expect(runtime.runStructured(request)).resolves.toBe(expected);
    if (captured === undefined) throw new Error("Configured runtime factory was not invoked");
    expect(captured.effortFallback?.deepest).toEqual(["high"]);
    expect(captured.environmentSanitizer?.sanitize(captured.environment ?? {}).environment).toEqual(
      { PATH: "/usr/bin" },
    );
    expect(captured.recorderFactory?.(expected.eventsPath)).toMatchObject({
      path: expected.eventsPath,
      maxBytes: 420,
    });
  });
});
