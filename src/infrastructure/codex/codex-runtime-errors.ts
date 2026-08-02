import { OrchestratorError } from "../../shared/errors.js";

export class CodexRuntimeError extends OrchestratorError {
  readonly compatibilityFailure: boolean;

  constructor(
    message: string,
    options: { cause?: unknown; resumable?: boolean; compatibilityFailure?: boolean } = {},
  ) {
    super(message, {
      code: "CODEX_RUNTIME",
      resumable: options.resumable ?? true,
      cause: options.cause,
    });
    this.name = "CodexRuntimeError";
    this.compatibilityFailure = options.compatibilityFailure ?? false;
  }
}

export class CodexTimeoutError extends CodexRuntimeError {
  constructor(timeoutMs: number, cause?: unknown) {
    super(`Codex call timed out after ${timeoutMs} ms`, { cause, resumable: true });
    this.name = "CodexTimeoutError";
  }
}

export function isModelEffortCompatibilityFailure(message: string): boolean {
  return /(?:reasoning|effort).*(?:unsupported|not supported|invalid)|model.*(?:unsupported|not supported).*(?:reasoning|effort)/iu.test(
    message,
  );
}
