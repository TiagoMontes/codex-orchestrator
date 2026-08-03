import type { ConfigService } from "../../application/configuration/config-service.js";
import { EnvironmentSanitizer } from "../process/environment-sanitizer.js";
import { CodexEventRecorder } from "./codex-event-recorder.js";
import type { CodexRunRequest, CodexRunResult, CodexRuntime } from "./codex-runtime.js";
import { CodexSdkRuntime, type CodexSdkRuntimeOptions } from "./codex-sdk-runtime.js";

export type ConfiguredCodexRuntimeFactory = (options: CodexSdkRuntimeOptions) => CodexRuntime;

/**
 * Resolves runtime policy for every call so a validated configuration edit takes
 * effect without allowing services to bypass the stable CodexRuntime boundary.
 */
export class ConfiguredCodexRuntime implements CodexRuntime {
  constructor(
    private readonly config: ConfigService,
    private readonly environment: Readonly<Record<string, string | undefined>> = process.env,
    private readonly runtimeFactory: ConfiguredCodexRuntimeFactory = (options) =>
      new CodexSdkRuntime(options),
  ) {}

  async runStructured<T>(request: CodexRunRequest<T>): Promise<CodexRunResult<T>> {
    const config = await this.config.load();
    return this.runtimeFactory({
      environment: this.environment,
      environmentSanitizer: new EnvironmentSanitizer(config.security.environmentAllowlist),
      effortFallback: config.models.reasoningFallback,
      recorderFactory: (path) => new CodexEventRecorder(path, config.storage.maxEventLogBytes),
    }).runStructured(request);
  }
}
