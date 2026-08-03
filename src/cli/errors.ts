import type { OutputWriter } from "./output.js";
import { toOrchestratorError } from "../shared/errors.js";

export type CliErrorOutputOptions = {
  debug?: boolean;
  json?: boolean;
};

export function handleCliError(
  error: unknown,
  writer: OutputWriter,
  options: CliErrorOutputOptions = {},
): number {
  const normalized = toOrchestratorError(error);
  const nextCommand = normalized.nextCommand ?? safeFallbackCommand(normalized.code);
  if (options.json === true) {
    writer.writeError(
      JSON.stringify({
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          exitCode: normalized.exitCode,
          resumable: normalized.resumable,
          nextCommand,
          ...(options.debug === true && normalized.stack !== undefined
            ? { stack: normalized.stack }
            : {}),
        },
      }),
    );
    return normalized.exitCode;
  }
  writer.writeError(`Error: ${normalized.message}`);
  writer.writeError(`Resumable: ${normalized.resumable ? "yes" : "no"}`);
  writer.writeError(`Next safe command: ${nextCommand}`);
  if (options.debug === true && normalized.stack !== undefined) {
    writer.writeError(normalized.stack);
  }
  return normalized.exitCode;
}

function safeFallbackCommand(code: ReturnType<typeof toOrchestratorError>["code"]): string {
  switch (code) {
    case "CLI_INPUT":
    case "GENERIC":
      return "cxo --help";
    case "CONFIGURATION":
      return "cxo config validate";
    case "PROJECT":
      return "cxo project list";
    case "CODEX_RUNTIME":
      return "cxo doctor";
    default:
      return "cxo task list";
  }
}
