import type { OutputWriter } from "./output.js";
import { toOrchestratorError } from "../shared/errors.js";

export function handleCliError(error: unknown, writer: OutputWriter, debug = false): number {
  const normalized = toOrchestratorError(error);
  writer.writeError(`Error: ${normalized.message}`);
  writer.writeError(`Resumable: ${normalized.resumable ? "yes" : "no"}`);
  if (normalized.nextCommand !== undefined) {
    writer.writeError(`Next safe command: ${normalized.nextCommand}`);
  }
  if (debug && normalized.stack !== undefined) {
    writer.writeError(normalized.stack);
  }
  return normalized.exitCode;
}
