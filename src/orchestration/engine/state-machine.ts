import type { TaskStateDocument, TaskTransition } from "../../domain/task/task-state.js";
import type { TaskStatus } from "../../domain/task/task.js";
import { OrchestratorError } from "../../shared/errors.js";

const ALLOWED_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  created: ["normalizing", "cancelled", "failed"],
  normalizing: ["ready-for-diagnosis", "failed", "cancelled"],
  "ready-for-diagnosis": ["diagnosing", "cancelled", "failed"],
  diagnosing: ["diagnosed", "blocked", "failed", "cancelled"],
  diagnosed: ["worktree-preparing", "cancelled", "failed"],
  "worktree-preparing": ["ready-for-implementation", "blocked", "failed", "cancelled"],
  "ready-for-implementation": ["implementing", "cancelled", "failed"],
  implementing: ["verifying", "blocked", "failed", "cancelled"],
  verifying: ["implementing", "reviewing", "blocked", "failed", "cancelled"],
  reviewing: ["completed", "correcting", "blocked", "failed", "cancelled"],
  correcting: ["verifying", "blocked", "failed", "cancelled"],
  completed: [],
  blocked: [
    "ready-for-diagnosis",
    "diagnosing",
    "worktree-preparing",
    "ready-for-implementation",
    "implementing",
    "verifying",
    "reviewing",
    "correcting",
    "cancelled",
    "failed",
  ],
  failed: [],
  cancelled: [],
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
      ...(input.nextState === "blocked" ? { resumableFrom: state.status } : {}),
      transitions: [...state.transitions, transition],
      updatedAt: input.timestamp,
    };
  }
}
