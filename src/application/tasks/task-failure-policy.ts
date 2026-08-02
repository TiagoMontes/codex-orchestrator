import type { ExecutionAttempt } from "../../domain/execution/execution-attempt.js";
import type { TaskStatus } from "../../domain/task/task.js";
import type { OrchestratorError } from "../../shared/errors.js";

export function taskFailureStatus(
  error: OrchestratorError,
): Extract<TaskStatus, "blocked" | "cancelled" | "failed"> {
  if (error.code === "CANCELLED") return "cancelled";
  return error.resumable ? "blocked" : "failed";
}

export function executionFailureStatus(
  error: OrchestratorError,
): Extract<ExecutionAttempt["status"], "blocked" | "cancelled" | "failed"> {
  return taskFailureStatus(error);
}
