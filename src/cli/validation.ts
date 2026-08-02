import type { ZodType } from "zod";
import { OrchestratorError } from "../shared/errors.js";

export function parseCliValue<T>(schema: ZodType<T>, value: unknown, option: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new OrchestratorError(
    `${option} is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    { code: "CLI_INPUT", cause: parsed.error },
  );
}
