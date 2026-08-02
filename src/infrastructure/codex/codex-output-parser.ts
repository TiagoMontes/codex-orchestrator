import type { ZodType } from "zod";
import { CodexRuntimeError } from "./codex-runtime-errors.js";

export function parseStructuredOutput<T>(finalResponse: string, validator: ZodType<T>): T {
  if (finalResponse.trim() === "") {
    throw new CodexRuntimeError("Codex completed without a final structured response", {
      resumable: false,
    });
  }
  let input: unknown;
  try {
    input = JSON.parse(finalResponse) as unknown;
  } catch (error) {
    throw new CodexRuntimeError("Codex final response is not valid JSON", {
      cause: error,
      resumable: true,
    });
  }
  const parsed = validator.safeParse(input);
  if (!parsed.success) {
    throw new CodexRuntimeError("Codex structured response failed runtime validation", {
      cause: parsed.error,
      resumable: true,
    });
  }
  return parsed.data;
}
