export type ErrorCode =
  | "GENERIC"
  | "CLI_INPUT"
  | "CONFIGURATION"
  | "PROJECT"
  | "TASK_STATE"
  | "CODEX_RUNTIME"
  | "VERIFICATION"
  | "REVIEW_CHANGES"
  | "BUDGET"
  | "CONTEXT_INTEGRITY"
  | "CANCELLED";

export const EXIT_CODES: Readonly<Record<ErrorCode, number>> = {
  GENERIC: 1,
  CLI_INPUT: 2,
  CONFIGURATION: 3,
  PROJECT: 4,
  TASK_STATE: 5,
  CODEX_RUNTIME: 6,
  VERIFICATION: 7,
  REVIEW_CHANGES: 8,
  BUDGET: 9,
  CONTEXT_INTEGRITY: 10,
  CANCELLED: 11,
};

export type OrchestratorErrorOptions = {
  code?: ErrorCode;
  resumable?: boolean;
  nextCommand?: string;
  cause?: unknown;
};

export class OrchestratorError extends Error {
  readonly code: ErrorCode;
  readonly resumable: boolean;
  readonly nextCommand: string | undefined;

  constructor(message: string, options: OrchestratorErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "OrchestratorError";
    this.code = options.code ?? "GENERIC";
    this.resumable = options.resumable ?? false;
    this.nextCommand = options.nextCommand;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export function toOrchestratorError(error: unknown): OrchestratorError {
  if (error instanceof OrchestratorError) {
    return error;
  }
  if (error instanceof Error) {
    return new OrchestratorError(error.message, { cause: error });
  }
  return new OrchestratorError("An unknown error occurred", { cause: error });
}
