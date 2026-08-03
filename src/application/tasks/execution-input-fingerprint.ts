import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";
import { OrchestratorError } from "../../shared/errors.js";
import { sha256, stableJson } from "../../shared/hashing.js";

export function executionInputFingerprint(input: unknown): string {
  return sha256(stableJson(input));
}

export function latestFailureObservation(
  attempts: readonly ExecutionAttempt[],
): Record<string, unknown> | null {
  const latest = [...attempts].reverse().find((attempt) => attempt.status !== "cancelled");
  if (latest === undefined || latest.status === "succeeded" || latest.status === "running") {
    return null;
  }
  return {
    status: latest.status,
    failureSignature: latest.failureSignature ?? null,
    error:
      latest.error === undefined
        ? null
        : {
            name: latest.error.name,
            message: latest.error.message,
            code: latest.error.code ?? null,
            resumable: latest.error.resumable,
          },
  };
}

export function assertRetryHasNewEvidence(
  attempts: readonly ExecutionAttempt[],
  fingerprint: string,
  phase: string,
): void {
  const latest = attempts.at(-1);
  if (
    latest !== undefined &&
    latest.status !== "cancelled" &&
    latest.inputFingerprint === fingerprint
  ) {
    throw new OrchestratorError(
      `${phase} retry requires new deterministic evidence or changed commit-scoped context`,
      {
        code: "TASK_STATE",
        resumable: true,
      },
    );
  }
}
