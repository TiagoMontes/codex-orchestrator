import type { TaskStateDocument, TaskTransition } from "../../domain/task/task-state.js";
import type { TaskStatus } from "../../domain/task/task.js";
import { OrchestratorError } from "../../shared/errors.js";

const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  created: ["normalizing", "blocked", "cancelled", "failed"],
  normalizing: ["ready-for-diagnosis", "blocked", "failed", "cancelled"],
  "ready-for-diagnosis": ["diagnosing", "blocked", "cancelled", "failed"],
  diagnosing: ["diagnosed", "blocked", "failed", "cancelled"],
  diagnosed: ["worktree-preparing", "blocked", "cancelled", "failed"],
  "worktree-preparing": ["ready-for-implementation", "blocked", "failed", "cancelled"],
  "ready-for-implementation": [
    "worktree-preparing",
    "implementing",
    "blocked",
    "cancelled",
    "failed",
  ],
  implementing: ["verifying", "blocked", "failed", "cancelled"],
  verifying: ["implementing", "reviewing", "blocked", "failed", "cancelled"],
  reviewing: ["completed", "correcting", "blocked", "failed", "cancelled"],
  correcting: ["verifying", "blocked", "failed", "cancelled"],
  completed: [],
  blocked: [
    "normalizing",
    "ready-for-diagnosis",
    "ready-for-implementation",
    "reviewing",
    "cancelled",
    "failed",
  ],
  failed: [],
  cancelled: [
    "normalizing",
    "ready-for-diagnosis",
    "ready-for-implementation",
    "reviewing",
    "failed",
  ],
};

export type TransitionInput = Omit<TaskTransition, "previousState" | "timestamp"> & {
  timestamp: string;
};

export class TaskStateMachine {
  canTransition(from: TaskStatus, to: TaskStatus): boolean {
    return ALLOWED_TRANSITIONS[from].includes(to);
  }

  transition(state: TaskStateDocument, input: TransitionInput): TaskStateDocument {
    if (!this.canTransition(state.status, input.nextState)) {
      throw new OrchestratorError(
        `Invalid task transition: ${state.status} -> ${input.nextState}`,
        {
          code: "TASK_STATE",
        },
      );
    }
    const transition: TaskTransition = {
      previousState: state.status,
      nextState: input.nextState,
      timestamp: input.timestamp,
      reason: input.reason,
      actor: input.actor,
      ...(input.executionId === undefined ? {} : { executionId: input.executionId }),
    };
    return {
      schemaVersion: state.schemaVersion,
      taskId: state.taskId,
      status: input.nextState,
      ...(input.nextState === "blocked" || input.nextState === "cancelled"
        ? {
            resumableFrom:
              state.status === "blocked" || state.status === "cancelled"
                ? (state.resumableFrom ?? state.status)
                : state.status,
          }
        : {}),
      transitions: [...state.transitions, transition],
      updatedAt: input.timestamp,
    };
  }
}
