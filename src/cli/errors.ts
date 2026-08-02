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
  if (options.json === true) {
    writer.writeError(
      JSON.stringify({
        ok: false,
        error: {
          code: normalized.code,
          message: normalized.message,
          exitCode: normalized.exitCode,
          resumable: normalized.resumable,
          ...(normalized.nextCommand === undefined ? {} : { nextCommand: normalized.nextCommand }),
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
  if (normalized.nextCommand !== undefined) {
    writer.writeError(`Next safe command: ${normalized.nextCommand}`);
  }
  if (options.debug === true && normalized.stack !== undefined) {
    writer.writeError(normalized.stack);
  }
  return normalized.exitCode;
}
